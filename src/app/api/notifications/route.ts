import { NextRequest, NextResponse } from 'next/server';
import { Notification } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { validateBody, notificationActionSchema } from '@/lib/validation';
import { logger } from '@/lib/logger';
import { getPrismaClient } from '@/lib/prisma';

/**
 * GET /api/notifications - Get notifications for a specific recipient
 * Query params: recipient, unread_only, type, limit, offset
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient();
    const { searchParams } = new URL(request.url);
    const workspaceId = auth.user.workspace_id ?? 1;
    
    // Parse query parameters
    const recipient = searchParams.get('recipient');
    const unread_only = searchParams.get('unread_only') === 'true';
    const type = searchParams.get('type');
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 500);
    const offset = parseInt(searchParams.get('offset') || '0');
    
    if (!recipient) {
      return NextResponse.json({ error: 'Recipient is required' }, { status: 400 });
    }
    
    const where: any = {
      recipient,
      workspace_id: workspaceId,
    }
    if (unread_only) where.read_at = null
    if (type) where.type = type

    const notifications = await prisma.notifications.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
      skip: offset,
    }) as unknown as Notification[]

    // Enhance notifications with related entity data without N+1 queries.
    const taskIds = new Set<number>()
    const commentIds = new Set<number>()
    const agentIds = new Set<number>()
    for (const n of notifications) {
      if (!n.source_type || !n.source_id) continue
      if (n.source_type === 'task') taskIds.add(n.source_id)
      else if (n.source_type === 'comment') commentIds.add(n.source_id)
      else if (n.source_type === 'agent') agentIds.add(n.source_id)
    }

    const [tasks, comments, agents] = await Promise.all([
      taskIds.size
        ? prisma.tasks.findMany({
            where: { id: { in: [...taskIds] }, workspace_id: workspaceId },
            select: { id: true, title: true, status: true },
          })
        : Promise.resolve([]),
      commentIds.size
        ? prisma.comments.findMany({
            where: { id: { in: [...commentIds] }, workspace_id: workspaceId, tasks: { workspace_id: workspaceId } },
            select: { id: true, content: true, task_id: true, tasks: { select: { title: true } } },
          })
        : Promise.resolve([]),
      agentIds.size
        ? prisma.agents.findMany({
            where: { id: { in: [...agentIds] }, workspace_id: workspaceId },
            select: { id: true, name: true, role: true, status: true },
          })
        : Promise.resolve([]),
    ])

    const taskMap = new Map(tasks.map((t) => [t.id, t]))
    const commentMap = new Map(comments.map((c: any) => [c.id, c]))
    const agentMap = new Map(agents.map((a) => [a.id, a]))

    const enhancedNotifications = notifications.map((notification) => {
      let sourceDetails: any = null
      try {
        if (notification.source_type && notification.source_id) {
          if (notification.source_type === 'task') {
            const task = taskMap.get(notification.source_id)
            if (task) sourceDetails = { type: 'task', ...task }
          } else if (notification.source_type === 'comment') {
            const comment = commentMap.get(notification.source_id)
            if (comment) {
              sourceDetails = {
                type: 'comment',
                id: comment.id,
                content: comment.content,
                task_id: comment.task_id,
                task_title: comment.tasks?.title ?? null,
                content_preview: comment.content?.substring(0, 100) || '',
              }
            }
          } else if (notification.source_type === 'agent') {
            const agent = agentMap.get(notification.source_id)
            if (agent) sourceDetails = { type: 'agent', ...agent }
          }
        }
      } catch (error) {
        logger.warn({ err: error, notificationId: (notification as any).id }, 'Failed to fetch source details for notification')
      }

      return { ...notification, source: sourceDetails }
    })
    
    // Get unread count for this recipient
    const unreadCount = await prisma.notifications.count({
      where: { recipient, read_at: null, workspace_id: workspaceId },
    })
    
    // Get total count for pagination
    const total = await prisma.notifications.count({ where })

    return NextResponse.json({
      notifications: enhancedNotifications,
      total,
      page: Math.floor(offset / limit) + 1,
      limit,
      unreadCount
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/notifications error');
    return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 });
  }
}

/**
 * PUT /api/notifications - Mark notifications as read
 * Body: { ids: number[] } or { recipient: string } (mark all as read)
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const prisma = getPrismaClient();
    const workspaceId = auth.user.workspace_id ?? 1;
    const body = await request.json();
    const { ids, recipient, markAllRead } = body;
    
    const now = Math.floor(Date.now() / 1000);
    
    if (markAllRead && recipient) {
      // Mark all notifications as read for this recipient
      const result = await prisma.notifications.updateMany({
        where: { recipient, read_at: null, workspace_id: workspaceId },
        data: { read_at: now },
      })
      
      return NextResponse.json({ 
        success: true, 
        markedAsRead: result.count 
      });
    } else if (ids && Array.isArray(ids)) {
      // Mark specific notifications as read
      const result = await prisma.notifications.updateMany({
        where: { id: { in: ids }, read_at: null, workspace_id: workspaceId },
        data: { read_at: now },
      })
      
      return NextResponse.json({ 
        success: true, 
        markedAsRead: result.count 
      });
    } else {
      return NextResponse.json({ 
        error: 'Either provide ids array or recipient with markAllRead=true' 
      }, { status: 400 });
    }
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/notifications error');
    return NextResponse.json({ error: 'Failed to update notifications' }, { status: 500 });
  }
}

/**
 * DELETE /api/notifications - Delete notifications
 * Body: { ids: number[] } or { recipient: string, olderThan: number }
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, 'admin');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const prisma = getPrismaClient();
    const workspaceId = auth.user.workspace_id ?? 1;
    const body = await request.json();
    const { ids, recipient, olderThan } = body;
    
    if (ids && Array.isArray(ids)) {
      // Delete specific notifications
      const result = await prisma.notifications.deleteMany({
        where: { id: { in: ids }, workspace_id: workspaceId },
      })
      
      return NextResponse.json({ 
        success: true, 
        deleted: result.count 
      });
    } else if (recipient && olderThan) {
      // Delete old notifications for recipient
      const result = await prisma.notifications.deleteMany({
        where: { recipient, created_at: { lt: olderThan }, workspace_id: workspaceId },
      })
      
      return NextResponse.json({ 
        success: true, 
        deleted: result.count 
      });
    } else {
      return NextResponse.json({ 
        error: 'Either provide ids array or recipient with olderThan timestamp' 
      }, { status: 400 });
    }
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/notifications error');
    return NextResponse.json({ error: 'Failed to delete notifications' }, { status: 500 });
  }
}

/**
 * POST /api/notifications/mark-delivered - Mark notifications as delivered to agent
 * Body: { agent: string }
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const prisma = getPrismaClient();
    const workspaceId = auth.user.workspace_id ?? 1;

    const result = await validateBody(request, notificationActionSchema);
    if ('error' in result) return result.error;
    const { agent, action } = result.data;

    if (action === 'mark-delivered') {
      
      const now = Math.floor(Date.now() / 1000);
      
      // Mark undelivered notifications as delivered
      const updated = await prisma.notifications.updateMany({
        where: { recipient: agent, delivered_at: null, workspace_id: workspaceId },
        data: { delivered_at: now },
      })
      
      // Get the notifications that were just marked as delivered
      const deliveredNotifications = await prisma.notifications.findMany({
        where: { recipient: agent, delivered_at: now, workspace_id: workspaceId },
        orderBy: { created_at: 'desc' },
      }) as unknown as Notification[]
      
      return NextResponse.json({ 
        success: true, 
        delivered: updated.count,
        notifications: deliveredNotifications
      });
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    logger.error({ err: error }, 'POST /api/notifications error');
    return NextResponse.json({ error: 'Failed to process notification action' }, { status: 500 });
  }
}
