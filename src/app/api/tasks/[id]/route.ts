import { NextRequest, NextResponse } from 'next/server';
import { Task, db_helpers } from '@/lib/db';
import { eventBus } from '@/lib/event-bus';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { validateBody, updateTaskSchema } from '@/lib/validation';
import { resolveMentionRecipientsAsync } from '@/lib/mentions';
import { normalizeTaskUpdateStatus } from '@/lib/task-status';
import { pushTaskToGitHub } from '@/lib/github-sync-engine';
import { getPrismaClient } from '@/lib/prisma';

function formatTicketRef(prefix?: string | null, num?: number | null): string | undefined {
  if (!prefix || typeof num !== 'number' || !Number.isFinite(num) || num <= 0) return undefined
  return `${prefix}-${String(num).padStart(3, '0')}`
}

function mapTaskRow(task: any): Task & { tags: string[]; metadata: Record<string, unknown> } {
  return {
    ...task,
    tags: task.tags ? JSON.parse(task.tags) : [],
    metadata: task.metadata ? JSON.parse(task.metadata) : {},
    ticket_ref: formatTicketRef(task.project_prefix, task.project_ticket_no),
  }
}

async function hasAegisApproval(
  prisma: ReturnType<typeof getPrismaClient>,
  taskId: number,
  workspaceId: number
): Promise<boolean> {
  const review = await prisma.quality_reviews.findFirst({
    where: { task_id: taskId, reviewer: 'aegis', workspace_id: workspaceId },
    select: { status: true },
    orderBy: { created_at: 'desc' },
  })
  return review?.status === 'approved'
}

/**
 * GET /api/tasks/[id] - Get a specific task
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'viewer');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const prisma = getPrismaClient();
    const resolvedParams = await params;
    const taskId = parseInt(resolvedParams.id);
    const workspaceId = auth.user.workspace_id ?? 1;

    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
    }
    
    const task = await prisma.tasks.findFirst({
      where: { id: taskId, workspace_id: workspaceId },
    })
    
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const project = task.project_id
      ? await prisma.projects.findFirst({
          where: { id: task.project_id, workspace_id: workspaceId },
          select: { name: true, ticket_prefix: true },
        })
      : null
    
    // Parse JSON fields
    const taskWithParsedData = mapTaskRow({
      ...(task as any),
      project_name: project?.name ?? null,
      project_prefix: project?.ticket_prefix ?? null,
    });
    
    return NextResponse.json({ task: taskWithParsedData });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/[id] error');
    return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 });
  }
}

/**
 * PUT /api/tasks/[id] - Update a specific task
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const prisma = getPrismaClient();
    const resolvedParams = await params;
    const taskId = parseInt(resolvedParams.id);
    const workspaceId = auth.user.workspace_id ?? 1;
    const validated = await validateBody(request, updateTaskSchema);
    if ('error' in validated) return validated.error;
    const body = validated.data;
    
    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
    }
    
    // Get current task for comparison
    const currentTask = await prisma.tasks.findFirst({
      where: { id: taskId, workspace_id: workspaceId },
    }) as unknown as Task | null;
    
    if (!currentTask) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    
    const {
      title,
      description,
      status: requestedStatus,
      priority,
      project_id,
      assigned_to,
      due_date,
      estimated_hours,
      actual_hours,
      outcome,
      error_message,
      resolution,
      feedback_rating,
      feedback_notes,
      retry_count,
      completed_at,
      tags,
      metadata
    } = body;
    const normalizedStatus = normalizeTaskUpdateStatus({
      currentStatus: currentTask.status,
      requestedStatus,
      assignedTo: assigned_to,
      assignedToProvided: assigned_to !== undefined,
    })
    
    const now = Math.floor(Date.now() / 1000);
    const descriptionMentionResolution = description !== undefined
      ? await resolveMentionRecipientsAsync(description || '', workspaceId)
      : null;
    if (descriptionMentionResolution && descriptionMentionResolution.unresolved.length > 0) {
      return NextResponse.json({
        error: `Unknown mentions: ${descriptionMentionResolution.unresolved.map((m) => `@${m}`).join(', ')}`,
        missing_mentions: descriptionMentionResolution.unresolved
      }, { status: 400 });
    }

    const previousDescriptionMentionRecipients = (await resolveMentionRecipientsAsync(
      currentTask.description || '',
      workspaceId
    )).recipients;

    if (normalizedStatus === 'done') {
      const approved = await hasAegisApproval(prisma, taskId, workspaceId)
      if (!approved) {
        return NextResponse.json(
          { error: 'Aegis approval is required to move task to done.' },
          { status: 403 }
        )
      }
    }

    // Pre-validate project change to preserve old 400 behavior.
    if (project_id !== undefined) {
      const project = await prisma.projects.findFirst({
        where: { id: project_id, workspace_id: workspaceId, status: 'active' },
        select: { id: true },
      })
      if (!project) return NextResponse.json({ error: 'Project not found or archived' }, { status: 400 })
    }

    const data: any = { updated_at: now }
    if (title !== undefined) data.title = title
    if (description !== undefined) data.description = description
    if (normalizedStatus !== undefined) data.status = normalizedStatus
    if (priority !== undefined) data.priority = priority
    if (assigned_to !== undefined) data.assigned_to = assigned_to
    if (due_date !== undefined) data.due_date = due_date
    if (estimated_hours !== undefined) data.estimated_hours = estimated_hours
    if (actual_hours !== undefined) data.actual_hours = actual_hours
    if (outcome !== undefined) data.outcome = outcome
    if (error_message !== undefined) data.error_message = error_message
    if (resolution !== undefined) data.resolution = resolution
    if (feedback_rating !== undefined) data.feedback_rating = feedback_rating
    if (feedback_notes !== undefined) data.feedback_notes = feedback_notes
    if (retry_count !== undefined) data.retry_count = retry_count
    if (completed_at !== undefined) {
      data.completed_at = completed_at
    } else if (normalizedStatus === 'done' && !currentTask.completed_at) {
      data.completed_at = now
    }
    if (tags !== undefined) data.tags = JSON.stringify(tags)
    if (metadata !== undefined) data.metadata = JSON.stringify(metadata)

    let nextProjectTicketNo: number | null = null
    if (project_id !== undefined) {
      data.project_id = project_id
    }

    if (Object.keys(data).length === 1) { // Only updated_at
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    await prisma.$transaction(async (tx) => {
      if (project_id !== undefined && project_id !== currentTask.project_id) {
        const updatedProject = await tx.projects.update({
          where: { id: project_id },
          data: { ticket_counter: { increment: 1 }, updated_at: now },
          select: { ticket_counter: true },
        })
        nextProjectTicketNo = updatedProject.ticket_counter
        data.project_ticket_no = nextProjectTicketNo
      }

      await tx.tasks.updateMany({
        where: { id: taskId, workspace_id: workspaceId },
        data,
      })
    })
    
    // Track changes and log activities
    const changes: string[] = [];
    
    if (normalizedStatus !== undefined && normalizedStatus !== currentTask.status) {
      changes.push(`status: ${currentTask.status} → ${normalizedStatus}`);
      
      // Create notification for status change if assigned
      if (currentTask.assigned_to) {
        db_helpers.createNotification(
          currentTask.assigned_to,
          'status_change',
          'Task Status Updated',
          `Task "${currentTask.title}" status changed to ${normalizedStatus}`,
          'task',
          taskId,
          workspaceId
        );
      }
    }
    
    if (assigned_to !== undefined && assigned_to !== currentTask.assigned_to) {
      changes.push(`assigned: ${currentTask.assigned_to || 'unassigned'} → ${assigned_to || 'unassigned'}`);
      
      // Create notification for new assignee
      if (assigned_to) {
        db_helpers.ensureTaskSubscription(taskId, assigned_to, workspaceId);
        db_helpers.createNotification(
          assigned_to,
          'assignment',
          'Task Assigned',
          `You have been assigned to task: ${currentTask.title}`,
          'task',
          taskId,
          workspaceId
        );
      }
    }
    
    if (title && title !== currentTask.title) {
      changes.push('title updated');
    }
    
    if (priority && priority !== currentTask.priority) {
      changes.push(`priority: ${currentTask.priority} → ${priority}`);
    }

    if (project_id !== undefined && project_id !== currentTask.project_id) {
      changes.push(`project: ${currentTask.project_id || 'none'} → ${project_id}`);
    }
    if (outcome !== undefined && outcome !== currentTask.outcome) {
      changes.push(`outcome: ${currentTask.outcome || 'unset'} → ${outcome || 'unset'}`);
    }

    if (descriptionMentionResolution) {
      const newMentionRecipients = new Set(descriptionMentionResolution.recipients);
      const previousRecipients = new Set(previousDescriptionMentionRecipients);
      for (const recipient of newMentionRecipients) {
        if (previousRecipients.has(recipient)) continue;
        db_helpers.ensureTaskSubscription(taskId, recipient, workspaceId);
        if (recipient === auth.user.username) continue;
        db_helpers.createNotification(
          recipient,
          'mention',
          'You were mentioned in a task description',
          `${auth.user.username} mentioned you in task "${title || currentTask.title}"`,
          'task',
          taskId,
          workspaceId
        );
      }
    }
    
    // Log activity if there were meaningful changes
    if (changes.length > 0) {
      db_helpers.logActivity(
        'task_updated',
        'task',
        taskId,
        auth.user.username,
        `Task updated: ${changes.join(', ')}`,
        { 
          changes: changes,
          oldValues: {
            title: currentTask.title,
            status: currentTask.status,
            priority: currentTask.priority,
            assigned_to: currentTask.assigned_to
          },
          newValues: { title, status: normalizedStatus ?? currentTask.status, priority, assigned_to }
        },
        workspaceId
      );
    }
    
    // Fetch updated task
    const updatedTask = await prisma.tasks.findFirst({
      where: { id: taskId, workspace_id: workspaceId },
    })
    if (!updatedTask) throw new Error('Task not found after update')

    const updatedProject = updatedTask.project_id
      ? await prisma.projects.findFirst({
          where: { id: updatedTask.project_id, workspace_id: workspaceId },
          select: { id: true, name: true, ticket_prefix: true, github_repo: true, github_sync_enabled: true },
        })
      : null

    const parsedTask = mapTaskRow({
      ...(updatedTask as any),
      project_name: updatedProject?.name ?? null,
      project_prefix: updatedProject?.ticket_prefix ?? null,
    });

    // Fire-and-forget outbound GitHub sync for relevant changes
    const syncRelevantChanges = changes.some(c =>
      c.startsWith('status:') || c.startsWith('priority:') || c.includes('title') || c.includes('assigned')
    )
    if (syncRelevantChanges && (updatedTask as any).github_repo && updatedProject?.github_sync_enabled) {
      pushTaskToGitHub(updatedTask as any, updatedProject as any).catch(err =>
        logger.error({ err, taskId }, 'Outbound GitHub sync failed')
      )
    }

    // Broadcast to SSE clients
    eventBus.broadcast('task.updated', parsedTask);

    return NextResponse.json({ task: parsedTask });
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/tasks/[id] error');
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

/**
 * DELETE /api/tasks/[id] - Delete a specific task
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const prisma = getPrismaClient();
    const resolvedParams = await params;
    const taskId = parseInt(resolvedParams.id);
    const workspaceId = auth.user.workspace_id ?? 1;
    
    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
    }
    
    // Get task before deletion for logging
    const task = await prisma.tasks.findFirst({
      where: { id: taskId, workspace_id: workspaceId },
    }) as unknown as Task | null;
    
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    
    // Delete task (cascades will handle comments)
    await prisma.tasks.deleteMany({ where: { id: taskId, workspace_id: workspaceId } })
    
    // Log deletion
    db_helpers.logActivity(
      'task_deleted',
      'task',
      taskId,
      auth.user.username,
      `Deleted task: ${task.title}`,
      {
        title: task.title,
        status: task.status,
        assigned_to: task.assigned_to
      },
      workspaceId
    );

    // Broadcast to SSE clients
    eventBus.broadcast('task.deleted', { id: taskId, title: task.title });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/tasks/[id] error');
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}
