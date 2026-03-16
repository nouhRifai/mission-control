import { NextRequest, NextResponse } from 'next/server';
import { Activity } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { getPrismaClient } from '@/lib/prisma';

/**
 * GET /api/activities - Get activity stream or stats
 * Query params: type, actor, entity_type, limit, offset, since, hours (for stats)
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams, pathname } = new URL(request.url);
    const workspaceId = auth.user.workspace_id ?? 1;
    
    // Route to stats endpoint if requested
    if (pathname.endsWith('/stats') || searchParams.has('stats')) {
      return handleStatsRequest(request, workspaceId);
    }
    
    // Default activities endpoint
    return handleActivitiesRequest(request, workspaceId);
  } catch (error) {
    logger.error({ err: error }, 'GET /api/activities error');
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
}

/**
 * Handle regular activities request
 */
async function handleActivitiesRequest(request: NextRequest, workspaceId: number) {
  try {
    const prisma = getPrismaClient();
    const { searchParams } = new URL(request.url);
    
    // Parse query parameters
    const type = searchParams.get('type');
    const actor = searchParams.get('actor');
    const entity_type = searchParams.get('entity_type');
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 500);
    const offset = parseInt(searchParams.get('offset') || '0');
    const since = searchParams.get('since'); // Unix timestamp for real-time updates
    
    const where: any = { workspace_id: workspaceId }

    if (type) {
      const types = type.split(',').map((t) => t.trim()).filter(Boolean)
      if (types.length === 1) where.type = types[0]
      else if (types.length > 1) where.type = { in: types }
    }

    if (actor) where.actor = actor
    if (entity_type) where.entity_type = entity_type
    if (since) {
      const sinceNum = Number.parseInt(since, 10)
      if (Number.isFinite(sinceNum)) where.created_at = { gt: sinceNum }
    }

    const [activities, total] = await Promise.all([
      prisma.activities.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.activities.count({ where }),
    ])

    const taskIds = new Set<number>()
    const agentIds = new Set<number>()
    const commentIds = new Set<number>()

    for (const activity of activities as any[]) {
      const id = Number(activity.entity_id)
      if (!Number.isFinite(id)) continue
      if (activity.entity_type === 'task') taskIds.add(id)
      else if (activity.entity_type === 'agent') agentIds.add(id)
      else if (activity.entity_type === 'comment') commentIds.add(id)
    }

    const [tasks, agents, comments] = await Promise.all([
      taskIds.size
        ? prisma.tasks.findMany({
            where: { workspace_id: workspaceId, id: { in: Array.from(taskIds) } },
            select: { id: true, title: true, status: true },
          })
        : Promise.resolve([]),
      agentIds.size
        ? prisma.agents.findMany({
            where: { workspace_id: workspaceId, id: { in: Array.from(agentIds) } },
            select: { id: true, name: true, role: true, status: true },
          })
        : Promise.resolve([]),
      commentIds.size
        ? prisma.comments.findMany({
            where: { workspace_id: workspaceId, id: { in: Array.from(commentIds) } },
            select: { id: true, content: true, task_id: true },
          })
        : Promise.resolve([]),
    ])

    const taskById = new Map(tasks.map((t: any) => [t.id, t]))
    const agentById = new Map(agents.map((a: any) => [a.id, a]))
    const commentById = new Map(comments.map((c: any) => [c.id, c]))

    const commentTaskIds = new Set<number>()
    for (const c of comments as any[]) {
      if (typeof c.task_id === 'number') commentTaskIds.add(c.task_id)
    }
    const commentTasks = commentTaskIds.size
      ? await prisma.tasks.findMany({
          where: { workspace_id: workspaceId, id: { in: Array.from(commentTaskIds) } },
          select: { id: true, title: true },
        })
      : []
    const commentTaskById = new Map(commentTasks.map((t: any) => [t.id, t]))

    // Parse JSON data field and enhance with related entity data
    const enhancedActivities = activities.map(activity => {
      let entityDetails = null;

      try {
        switch (activity.entity_type) {
          case 'task': {
            const task = taskById.get(activity.entity_id) as any;
            if (task) {
              entityDetails = { type: 'task', ...task };
            }
            break;
          }
          case 'agent': {
            const agent = agentById.get(activity.entity_id) as any;
            if (agent) {
              entityDetails = { type: 'agent', ...agent };
            }
            break;
          }
          case 'comment': {
            const comment = commentById.get(activity.entity_id) as any;
            if (comment) {
              const task = typeof comment.task_id === 'number' ? commentTaskById.get(comment.task_id) : null
              entityDetails = {
                type: 'comment',
                ...comment,
                task_title: task?.title ?? null,
                content_preview: comment.content?.substring(0, 100) || ''
              };
            }
            break;
          }
        }
      } catch (error) {
        logger.warn({ err: error, activityId: activity.id }, 'Failed to fetch entity details for activity');
      }

      return {
        ...activity,
        data: activity.data ? JSON.parse(activity.data) : null,
        entity: entityDetails
      };
    });

    return NextResponse.json({ 
      activities: enhancedActivities,
      total,
      hasMore: offset + activities.length < total
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/activities (activities) error');
    return NextResponse.json({ error: 'Failed to fetch activities' }, { status: 500 });
  }
}

/**
 * Handle stats request
 */
async function handleStatsRequest(request: NextRequest, workspaceId: number) {
  try {
    const prisma = getPrismaClient();
    const { searchParams } = new URL(request.url);
    
    // Parse timeframe parameter (defaults to 24 hours)
    const hours = parseInt(searchParams.get('hours') || '24');
    const since = Math.floor(Date.now() / 1000) - (hours * 3600);
    
    // Prisma `groupBy` typings can be brittle in this repo’s dual-provider setup,
    // so we aggregate in-memory for stats. This endpoint is diagnostics-style.
    const rows = await prisma.activities.findMany({
      where: { created_at: { gt: since }, workspace_id: workspaceId },
      select: { type: true, actor: true, created_at: true },
    })

    const byType = new Map<string, number>()
    const byActor = new Map<string, number>()
    const bucketCounts = new Map<number, number>()

    for (const row of rows as any[]) {
      const type = String(row.type || '')
      if (type) byType.set(type, (byType.get(type) ?? 0) + 1)

      const actor = String(row.actor || '')
      if (actor) byActor.set(actor, (byActor.get(actor) ?? 0) + 1)

      const createdAt = Number(row.created_at)
      if (Number.isFinite(createdAt)) {
        const bucket = Math.floor(createdAt / 3600) * 3600
        bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1)
      }
    }

    const activityStats = [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)

    const activeActors = [...byActor.entries()]
      .map(([actor, activity_count]) => ({ actor, activity_count }))
      .sort((a, b) => b.activity_count - a.activity_count)
      .slice(0, 10)

    // Get activity timeline (hourly buckets)
    const timeline = [...bucketCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hour_bucket, count]) => ({ hour_bucket, count }))
    
    return NextResponse.json({
      timeframe: `${hours} hours`,
      activityByType: activityStats,
      topActors: activeActors,
      timeline: timeline.map(item => ({
        timestamp: item.hour_bucket,
        count: item.count,
        hour: new Date(item.hour_bucket * 1000).toISOString()
      }))
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/activities (stats) error');
    return NextResponse.json({ error: 'Failed to fetch activity stats' }, { status: 500 });
  }
}
