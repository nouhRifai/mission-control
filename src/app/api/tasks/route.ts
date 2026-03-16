import { NextRequest, NextResponse } from 'next/server';
import { Task, db_helpers } from '@/lib/db';
import { eventBus } from '@/lib/event-bus';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { validateBody, createTaskSchema, bulkUpdateTaskStatusSchema } from '@/lib/validation';
import { resolveMentionRecipientsAsync } from '@/lib/mentions';
import { normalizeTaskCreateStatus } from '@/lib/task-status';
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

async function resolveProjectId(
  prisma: ReturnType<typeof getPrismaClient>,
  workspaceId: number,
  requestedProjectId?: number
): Promise<number> {
  if (typeof requestedProjectId === 'number' && Number.isFinite(requestedProjectId)) {
    const project = await prisma.projects.findFirst({
      where: { id: requestedProjectId, workspace_id: workspaceId, status: 'active' },
      select: { id: true },
    })
    if (project) return project.id
  }

  // Legacy ordering: "general" first, otherwise first by id.
  const general = await prisma.projects.findFirst({
    where: { workspace_id: workspaceId, status: 'active', slug: 'general' },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  if (general) return general.id

  const fallback = await prisma.projects.findFirst({
    where: { workspace_id: workspaceId, status: 'active' },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  if (!fallback) throw new Error('No active project available in workspace')
  return fallback.id
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
 * GET /api/tasks - List all tasks with optional filtering
 * Query params: status, assigned_to, priority, project_id, limit, offset
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const prisma = getPrismaClient();
    const workspaceId = auth.user.workspace_id;
    const { searchParams } = new URL(request.url);

    // Parse query parameters
    const status = searchParams.get('status');
    const assigned_to = searchParams.get('assigned_to');
    const priority = searchParams.get('priority');
    const projectIdParam = Number.parseInt(searchParams.get('project_id') || '', 10);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
    const offset = parseInt(searchParams.get('offset') || '0');
    
    const where: any = {
      workspace_id: workspaceId,
      ...(status ? { status } : {}),
      ...(assigned_to ? { assigned_to } : {}),
      ...(priority ? { priority } : {}),
      ...(Number.isFinite(projectIdParam) ? { project_id: projectIdParam } : {}),
    }

    const [rows, total] = await Promise.all([
      prisma.tasks.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.tasks.count({ where }),
    ])

    const projectIds = Array.from(new Set(rows.map((t) => t.project_id).filter((id): id is number => typeof id === 'number')))
    const projects = projectIds.length
      ? await prisma.projects.findMany({
          where: { id: { in: projectIds }, workspace_id: workspaceId },
          select: { id: true, name: true, ticket_prefix: true },
        })
      : []
    const projectById = new Map(projects.map((p) => [p.id, p]))

    const tasksWithParsedData = rows.map((t) => {
      const proj = typeof t.project_id === 'number' ? projectById.get(t.project_id) : undefined
      return mapTaskRow({
        ...(t as any),
        project_name: proj?.name ?? null,
        project_prefix: proj?.ticket_prefix ?? null,
      })
    })

    return NextResponse.json({
      tasks: tasksWithParsedData,
      total,
      page: Math.floor(offset / limit) + 1,
      limit,
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks error');
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}

/**
 * POST /api/tasks - Create a new task
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const prisma = getPrismaClient();
    const workspaceId = auth.user.workspace_id;
    const validated = await validateBody(request, createTaskSchema);
    if ('error' in validated) return validated.error;
    const body = validated.data;

    const user = auth.user
    const actor = user.display_name || user.username || 'system'
    const {
      title,
      description,
      status,
      priority = 'medium',
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
      retry_count = 0,
      completed_at,
      tags = [],
      metadata = {}
    } = body;
    const normalizedStatus = normalizeTaskCreateStatus(status, assigned_to)

    // Resolve project_id for the task
    const resolvedProjectId = await resolveProjectId(prisma, workspaceId, project_id)
    
    const now = Math.floor(Date.now() / 1000);
    const mentionResolution = await resolveMentionRecipientsAsync(description || '', workspaceId);
    if (mentionResolution.unresolved.length > 0) {
      return NextResponse.json({
        error: `Unknown mentions: ${mentionResolution.unresolved.map((m) => `@${m}`).join(', ')}`,
        missing_mentions: mentionResolution.unresolved
      }, { status: 400 });
    }

    const resolvedCompletedAt = completed_at ?? (normalizedStatus === 'done' ? now : null)

    const taskId = await prisma.$transaction(async (tx) => {
      const project = await tx.projects.update({
        where: { id: resolvedProjectId },
        data: { ticket_counter: { increment: 1 }, updated_at: now },
        select: { ticket_counter: true },
      })
      if (!project?.ticket_counter) throw new Error('Failed to allocate project ticket number')

      const created = await tx.tasks.create({
        data: {
          title,
          description: description ?? null,
          status: normalizedStatus,
          priority,
          project_id: resolvedProjectId,
          project_ticket_no: project.ticket_counter,
          assigned_to: assigned_to ?? null,
          created_by: actor,
          created_at: now,
          updated_at: now,
          due_date: due_date ?? null,
          estimated_hours: estimated_hours ?? null,
          actual_hours: actual_hours ?? null,
          outcome: outcome ?? null,
          error_message: error_message ?? null,
          resolution: resolution ?? null,
          feedback_rating: feedback_rating ?? null,
          feedback_notes: feedback_notes ?? null,
          retry_count: retry_count ?? 0,
          completed_at: resolvedCompletedAt,
          tags: JSON.stringify(tags ?? []),
          metadata: JSON.stringify(metadata ?? {}),
          workspace_id: workspaceId,
        } as any,
        select: { id: true },
      })
      return created.id
    })
    
    // Log activity
    db_helpers.logActivity('task_created', 'task', taskId, actor, `Created task: ${title}`, {
      title,
      status: normalizedStatus,
      priority,
      assigned_to,
      ...(outcome ? { outcome } : {})
    }, workspaceId);

    if (actor) {
      db_helpers.ensureTaskSubscription(taskId, actor, workspaceId)
    }

    for (const recipient of mentionResolution.recipients) {
      db_helpers.ensureTaskSubscription(taskId, recipient, workspaceId);
      if (recipient === actor) continue;
      db_helpers.createNotification(
        recipient,
        'mention',
        'You were mentioned in a task description',
        `${actor} mentioned you in task "${title}"`,
        'task',
        taskId,
        workspaceId
      );
    }

    // Create notification if assigned
    if (assigned_to) {
      db_helpers.ensureTaskSubscription(taskId, assigned_to, workspaceId)
      db_helpers.createNotification(
        assigned_to,
        'assignment',
        'Task Assigned',
        `You have been assigned to task: ${title}`,
        'task',
        taskId,
        workspaceId
      );
    }
    
    // Fetch the created task
    const createdTask = await prisma.tasks.findFirst({
      where: { id: taskId, workspace_id: workspaceId },
    })
    if (!createdTask) throw new Error('Created task not found')
    const project = createdTask.project_id
      ? await prisma.projects.findFirst({
          where: { id: createdTask.project_id, workspace_id: workspaceId },
          select: { name: true, ticket_prefix: true, github_repo: true, github_sync_enabled: true, id: true },
        })
      : null
    const parsedTask = mapTaskRow({
      ...(createdTask as any),
      project_name: project?.name ?? null,
      project_prefix: project?.ticket_prefix ?? null,
    });

    // Fire-and-forget outbound GitHub sync for new tasks
    if (project?.github_sync_enabled && project?.github_repo) {
      pushTaskToGitHub(parsedTask as any, project as any).catch((err) =>
        logger.error({ err, taskId }, 'Outbound GitHub sync failed for new task')
      )
    }

    // Broadcast to SSE clients
    eventBus.broadcast('task.created', parsedTask);

    return NextResponse.json({ task: parsedTask }, { status: 201 });
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks error');
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}

/**
 * PUT /api/tasks - Update multiple tasks (for drag-and-drop status changes)
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const prisma = getPrismaClient();
    const workspaceId = auth.user.workspace_id;
    const validated = await validateBody(request, bulkUpdateTaskStatusSchema);
    if ('error' in validated) return validated.error;
    const { tasks } = validated.data;

    const now = Math.floor(Date.now() / 1000);

    const actor = auth.user.username

    const ids = Array.from(new Set(tasks.map((t: any) => Number(t.id)).filter((id: number) => Number.isFinite(id))))
    const oldTasks = ids.length
      ? await prisma.tasks.findMany({
          where: { id: { in: ids }, workspace_id: workspaceId },
          select: { id: true, status: true, completed_at: true },
        })
      : []
    const oldById = new Map(oldTasks.map((t) => [t.id, t]))

    await prisma.$transaction(async (tx) => {
      for (const task of tasks as any[]) {
        const taskId = Number(task.id)
        if (!Number.isFinite(taskId)) continue
        const oldTask = oldById.get(taskId)
        if (!oldTask) continue

        if (task.status === 'done') {
          const approved = await hasAegisApproval(tx as any, taskId, workspaceId)
          if (!approved) throw new Error(`Aegis approval required for task ${taskId}`)
        }

        const completedAt = task.status === 'done' ? (oldTask.completed_at ?? now) : oldTask.completed_at
        await tx.tasks.updateMany({
          where: { id: taskId, workspace_id: workspaceId },
          data: {
            status: task.status,
            updated_at: now,
            ...(task.status === 'done' ? { completed_at: completedAt } : {}),
          } as any,
        })

        if (oldTask.status !== task.status) {
          db_helpers.logActivity(
            'task_updated',
            'task',
            taskId,
            actor,
            `Task moved from ${oldTask.status} to ${task.status}`,
            { oldStatus: oldTask.status, newStatus: task.status },
            workspaceId
          )
        }
      }
    })

    // Broadcast status changes to SSE clients
    for (const task of tasks) {
      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: task.status,
        updated_at: Math.floor(Date.now() / 1000),
      });
    }

    return NextResponse.json({ success: true, updated: tasks.length });
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/tasks error');
    const message = error instanceof Error ? error.message : 'Failed to update tasks'
    if (message.includes('Aegis approval required')) {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    return NextResponse.json({ error: 'Failed to update tasks' }, { status: 500 });
  }
}
