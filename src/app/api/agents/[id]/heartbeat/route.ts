import { NextRequest, NextResponse } from 'next/server';
import { db_helpers } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { agentHeartbeatLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { resolveTaskImplementationTarget } from '@/lib/task-routing';
import { getPrismaClient } from '@/lib/prisma';

/**
 * GET /api/agents/[id]/heartbeat - Agent heartbeat check
 * 
 * Checks for:
 * - @mentions in recent comments
 * - Assigned tasks
 * - Recent activity feed items
 * 
 * Returns work items or "HEARTBEAT_OK" if nothing to do
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient();
    const resolvedParams = await params;
    const agentId = resolvedParams.id;
    const workspaceId = auth.user.workspace_id ?? 1;
    
    // Get agent by ID or name
    let agent: any;
    if (isNaN(Number(agentId))) {
      // Lookup by name
      agent = await prisma.agents.findFirst({ where: { name: agentId, workspace_id: workspaceId } });
    } else {
      // Lookup by ID
      agent = await prisma.agents.findFirst({ where: { id: Number(agentId), workspace_id: workspaceId } });
    }
    
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    
    const workItems: any[] = [];
    const now = Math.floor(Date.now() / 1000);
    const fourHoursAgo = now - (4 * 60 * 60); // Check last 4 hours
    
    // 1. Check for @mentions in recent comments
    const mentions = await prisma.comments.findMany({
      where: {
        workspace_id: workspaceId,
        created_at: { gt: fourHoursAgo },
        mentions: { contains: `"${agent.name}"` },
        tasks: { workspace_id: workspaceId },
      },
      include: { tasks: { select: { title: true } } },
      orderBy: { created_at: 'desc' },
      take: 10,
    });
    
    if (mentions.length > 0) {
      workItems.push({
        type: 'mentions',
        count: mentions.length,
        items: mentions.map((m: any) => ({
          id: m.id,
          task_title: m.tasks?.title,
          author: m.author,
          content: m.content.length > 100 ? m.content.substring(0, 100) + '...' : m.content,
          created_at: m.created_at
        }))
      });
    }
    
    // 2. Check for assigned tasks
    const assignedTasks = await prisma.tasks.findMany({
      where: {
        assigned_to: agent.name,
        workspace_id: workspaceId,
        status: { in: ['assigned', 'in_progress'] },
      },
      orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
      take: 10,
    });

    if (assignedTasks.length > 0) {
      workItems.push({
        type: 'assigned_tasks',
        count: assignedTasks.length,
        items: assignedTasks.map((t: any) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          due_date: t.due_date,
          ...resolveTaskImplementationTarget(t),
        }))
      });
    }
    
    // 3. Check for unread notifications
    const notifications = await prisma.notifications.findMany({
      where: { recipient: agent.name, read_at: null, workspace_id: workspaceId },
      orderBy: { created_at: 'desc' },
    });
    
    if (notifications.length > 0) {
      workItems.push({
        type: 'notifications',
        count: notifications.length,
        items: notifications.slice(0, 5).map(n => ({
          id: n.id,
          type: n.type,
          title: n.title,
          message: n.message,
          created_at: n.created_at
        }))
      });
    }
    
    // 4. Check for urgent activities that might need attention
    const urgentActivities = await prisma.activities.findMany({
      where: {
        type: { in: ['task_created', 'task_assigned', 'high_priority_alert'] },
        workspace_id: workspaceId,
        created_at: { gt: fourHoursAgo },
        description: { contains: agent.name },
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    
    if (urgentActivities.length > 0) {
      workItems.push({
        type: 'urgent_activities',
        count: urgentActivities.length,
        items: urgentActivities.map((a: any) => ({
          id: a.id,
          type: a.type,
          description: a.description,
          created_at: a.created_at
        }))
      });
    }
    
    // Update agent last_seen and status to show heartbeat activity
    db_helpers.updateAgentStatus(agent.name, 'idle', 'Heartbeat check', workspaceId);
    
    // Log heartbeat activity
    db_helpers.logActivity(
      'agent_heartbeat',
      'agent',
      agent.id,
      agent.name,
      `Heartbeat check completed - ${workItems.length > 0 ? `${workItems.length} work items found` : 'no work items'}`,
      { workItemsCount: workItems.length, workItemTypes: workItems.map(w => w.type) },
      workspaceId
    );
    
    if (workItems.length === 0) {
      return NextResponse.json({
        status: 'HEARTBEAT_OK',
        agent: agent.name,
        checked_at: now,
        message: 'No work items found'
      });
    }
    
    return NextResponse.json({
      status: 'WORK_ITEMS_FOUND',
      agent: agent.name,
      checked_at: now,
      work_items: workItems,
      total_items: workItems.reduce((sum, item) => sum + item.count, 0)
    });
    
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/heartbeat error');
    return NextResponse.json({ error: 'Failed to perform heartbeat check' }, { status: 500 });
  }
}

/**
 * POST /api/agents/[id]/heartbeat - Enhanced heartbeat
 *
 * Accepts optional body:
 * - connection_id: update direct_connections.last_heartbeat
 * - status: agent status override
 * - last_activity: activity description
 * - token_usage: { model, inputTokens, outputTokens, taskId? } for inline token reporting
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateLimited = agentHeartbeatLimiter(request);
  if (rateLimited) return rateLimited;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine — fall through to standard heartbeat
  }

  const { connection_id, token_usage } = body;
  const prisma = getPrismaClient();
  const now = Math.floor(Date.now() / 1000);
  const workspaceId = auth.user.workspace_id ?? 1;

  // Update direct connection heartbeat if connection_id provided
  if (connection_id) {
    await prisma.direct_connections.updateMany({
      where: { connection_id, status: 'connected', workspace_id: workspaceId },
      data: { last_heartbeat: now, updated_at: now },
    })
  }

  // Inline token reporting
  let tokenRecorded = false;
  if (token_usage && token_usage.model && token_usage.inputTokens != null && token_usage.outputTokens != null) {
    const resolvedParams = await params;
    const agentId = resolvedParams.id;
    let agent: any;
    if (isNaN(Number(agentId))) {
      agent = await prisma.agents.findFirst({ where: { name: agentId, workspace_id: workspaceId } });
    } else {
      agent = await prisma.agents.findFirst({ where: { id: Number(agentId), workspace_id: workspaceId } });
    }

    if (agent) {
      const sessionId = `${agent.name}:cli`;
      const parsedTaskId =
        token_usage.taskId != null && Number.isFinite(Number(token_usage.taskId))
          ? Number(token_usage.taskId)
          : null

      let taskId: number | null = null
      if (parsedTaskId && parsedTaskId > 0) {
        const taskRow = await prisma.tasks.findFirst({
          where: { id: parsedTaskId, workspace_id: workspaceId },
          select: { id: true },
        })
        if (taskRow?.id) {
          taskId = taskRow.id
        } else {
          logger.warn({ taskId: parsedTaskId, workspaceId, agent: agent.name }, 'Ignoring token usage with unknown taskId')
        }
      }

      await prisma.token_usage.create({
        data: {
          model: token_usage.model,
          session_id: sessionId,
          input_tokens: token_usage.inputTokens,
          output_tokens: token_usage.outputTokens,
          created_at: now,
          workspace_id: workspaceId,
          task_id: taskId,
          agent_name: agent.name,
        },
        select: { id: true },
      })
      tokenRecorded = true;
    }
  }

  // Reuse GET logic for work-items check, then augment response
  const getResponse = await GET(request, { params });
  const getBody = await getResponse.json();

  return NextResponse.json({
    ...getBody,
    token_recorded: tokenRecorded,
  });
}
