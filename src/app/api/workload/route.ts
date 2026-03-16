import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { getPrismaClient } from '@/lib/prisma';

/**
 * GET /api/workload - Real-Time Workload Signals
 *
 * Provides system-wide capacity metrics and throttle recommendations
 * so agents can make informed decisions about work submission.
 *
 * Response:
 *   capacity    - Current system capacity metrics
 *   queue       - Task queue depth and breakdown
 *   agents      - Agent availability and load distribution
 *   recommendation - Actionable signal: normal | throttle | shed | pause
 *   thresholds  - Current threshold configuration
 *
 * Agents should call this before submitting new work to avoid
 * cascading failures and SLO breaches.
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const prisma = getPrismaClient();
    const workspaceId = auth.user.workspace_id ?? 1;
    const now = Math.floor(Date.now() / 1000);

    // --- Capacity metrics ---
    const capacity = await buildCapacityMetrics(prisma, workspaceId, now);

    // --- Queue depth ---
    const queue = await buildQueueMetrics(prisma, workspaceId);

    // --- Agent availability ---
    const agents = await buildAgentMetrics(prisma, workspaceId, now);

    // --- Recommendation ---
    const recommendation = computeRecommendation(capacity, queue, agents);

    return NextResponse.json({
      timestamp: now,
      workspace_id: workspaceId,
      capacity,
      queue,
      agents,
      recommendation,
      thresholds: THRESHOLDS,
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/workload error');
    return NextResponse.json({ error: 'Failed to fetch workload signals' }, { status: 500 });
  }
}

// Configurable thresholds for recommendation engine
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildThresholds() {
  return {
    queue_depth_normal: numEnv('MC_WORKLOAD_QUEUE_DEPTH_NORMAL', 20),
    queue_depth_throttle: numEnv('MC_WORKLOAD_QUEUE_DEPTH_THROTTLE', 50),
    queue_depth_shed: numEnv('MC_WORKLOAD_QUEUE_DEPTH_SHED', 100),
    busy_agent_ratio_throttle: numEnv('MC_WORKLOAD_BUSY_RATIO_THROTTLE', 0.8),
    busy_agent_ratio_shed: numEnv('MC_WORKLOAD_BUSY_RATIO_SHED', 0.95),
    error_rate_throttle: numEnv('MC_WORKLOAD_ERROR_RATE_THROTTLE', 0.1),
    error_rate_shed: numEnv('MC_WORKLOAD_ERROR_RATE_SHED', 0.25),
    recent_window_seconds: Math.max(1, Math.floor(numEnv('MC_WORKLOAD_RECENT_WINDOW_SECONDS', 300))),
  };
}

const THRESHOLDS = buildThresholds();

interface CapacityMetrics {
  active_tasks: number;
  tasks_last_5m: number;
  errors_last_5m: number;
  error_rate_5m: number;
  completions_last_hour: number;
  avg_completion_rate_per_hour: number;
}

interface QueueMetrics {
  total_pending: number;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  oldest_pending_age_seconds: number | null;
  estimated_wait_seconds: number | null;
  estimated_wait_confidence: 'calculated' | 'unknown';
}

interface AgentMetrics {
  total: number;
  online: number;
  busy: number;
  idle: number;
  offline: number;
  busy_ratio: number;
  load_distribution: Array<{ agent: string; assigned: number; in_progress: number }>;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

async function buildCapacityMetrics(prisma: ReturnType<typeof getPrismaClient>, workspaceId: number, now: number): Promise<CapacityMetrics> {
  const recentWindow = now - THRESHOLDS.recent_window_seconds;
  const hourAgo = now - 3600;

  const [activeTasks, tasksLast5m, totalLast5m, completionsLastHour] = await Promise.all([
    prisma.tasks.count({
      where: { workspace_id: workspaceId, status: { in: ['assigned', 'in_progress', 'review', 'quality_review'] } },
    }),
    prisma.activities.count({
      where: { workspace_id: workspaceId, created_at: { gte: recentWindow }, type: { in: ['task_created', 'task_assigned'] } },
    }),
    prisma.activities.count({
      where: { workspace_id: workspaceId, created_at: { gte: recentWindow } },
    }),
    prisma.tasks.count({
      where: { workspace_id: workspaceId, status: 'done', updated_at: { gte: hourAgo } },
    }),
  ])

  const errorsLast5m = toNumber(
    (
      await prisma.$queryRaw<any[]>`
        SELECT COUNT(*) as c
        FROM activities
        WHERE workspace_id = ${workspaceId}
          AND created_at >= ${recentWindow}
          AND (lower(type) LIKE '%error%' OR lower(type) LIKE '%fail%')
      `
    )[0]?.c
  )

  // Average completion rate over last 24h
  const dayAgo = now - 86400;
  const completionsLastDay = await prisma.tasks.count({
    where: { workspace_id: workspaceId, status: 'done', updated_at: { gte: dayAgo } },
  })

  const safeErrorRate = totalLast5m > 0 ? errorsLast5m / totalLast5m : 0;

  return {
    active_tasks: activeTasks,
    tasks_last_5m: tasksLast5m,
    errors_last_5m: errorsLast5m,
    error_rate_5m: Math.max(0, Math.min(1, Math.round(safeErrorRate * 10000) / 10000)),
    completions_last_hour: completionsLastHour,
    avg_completion_rate_per_hour: Math.round((completionsLastDay / 24) * 100) / 100,
  };
}

async function buildQueueMetrics(prisma: ReturnType<typeof getPrismaClient>, workspaceId: number): Promise<QueueMetrics> {
  const now = Math.floor(Date.now() / 1000);

  const pendingStatuses = ['inbox', 'assigned', 'in_progress', 'review', 'quality_review'];

  const byStatusEntries = await Promise.all(
    pendingStatuses.map(async (status) => ({
      status,
      count: await prisma.tasks.count({ where: { workspace_id: workspaceId, status } }),
    }))
  )

  const priorities = ['critical', 'high', 'medium', 'low']
  const byPriorityEntries = await Promise.all(
    priorities.map(async (priority) => ({
      priority,
      count: await prisma.tasks.count({
        where: { workspace_id: workspaceId, priority, status: { in: pendingStatuses } },
      }),
    }))
  )

  const totalPending = byStatusEntries.reduce((sum, r) => sum + r.count, 0);

  const oldestAgg = await prisma.tasks.aggregate({
    where: { workspace_id: workspaceId, status: { in: ['inbox', 'assigned'] } },
    _min: { created_at: true },
  })

  const oldestCreatedAt = oldestAgg._min.created_at ?? null
  const oldestAge = typeof oldestCreatedAt === 'number' ? now - oldestCreatedAt : null;

  // Estimate wait: pending tasks / completion rate per hour * 3600
  const hourAgo = now - 3600;
  const completionsLastHour = await prisma.tasks.count({
    where: { workspace_id: workspaceId, status: 'done', updated_at: { gte: hourAgo } },
  })

  const estimatedWait = completionsLastHour > 0
    ? Math.round((totalPending / completionsLastHour) * 3600)
    : null;

  const statusMap = Object.fromEntries(byStatusEntries.map(r => [r.status, r.count]));
  for (const status of pendingStatuses) {
    if (typeof statusMap[status] !== 'number') statusMap[status] = 0;
  }

  const priorityMap = Object.fromEntries(byPriorityEntries.map(r => [r.priority, r.count]));
  for (const priority of ['low', 'medium', 'high', 'critical', 'urgent']) {
    if (typeof priorityMap[priority] !== 'number') priorityMap[priority] = 0;
  }

  return {
    total_pending: totalPending,
    by_status: statusMap,
    by_priority: priorityMap,
    oldest_pending_age_seconds: oldestAge,
    estimated_wait_seconds: estimatedWait,
    estimated_wait_confidence: estimatedWait === null ? 'unknown' : 'calculated',
  };
}

async function buildAgentMetrics(prisma: ReturnType<typeof getPrismaClient>, workspaceId: number, now: number): Promise<AgentMetrics> {
  const statuses = ['offline', 'idle', 'busy', 'error']
  const statusCounts = await Promise.all(
    statuses.map(async (status) => ({
      status,
      count: await prisma.agents.count({ where: { workspace_id: workspaceId, status } }),
    }))
  )

  const statusMap: Record<string, number> = {}
  let total = 0
  for (const row of statusCounts) {
    statusMap[row.status] = row.count
    total += row.count
  }

  const online = (statusMap['idle'] || 0) + (statusMap['busy'] || 0);
  const busy = statusMap['busy'] || 0;
  const idle = statusMap['idle'] || 0;
  const offline = statusMap['offline'] || 0;

  // Load distribution per agent
  const loadDistRaw = await prisma.$queryRaw<any[]>`
    SELECT a.name as agent,
      SUM(CASE WHEN t.status = 'assigned' THEN 1 ELSE 0 END) as assigned,
      SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
    FROM agents a
    LEFT JOIN tasks t ON t.assigned_to = a.name AND t.workspace_id = a.workspace_id AND t.status IN ('assigned', 'in_progress')
    WHERE a.workspace_id = ${workspaceId} AND a.status != 'offline'
    GROUP BY a.name
    ORDER BY (SUM(CASE WHEN t.status = 'assigned' THEN 1 ELSE 0 END) + SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END)) DESC
  `
  const loadDist = loadDistRaw.map((row) => ({
    agent: String(row.agent),
    assigned: toNumber(row.assigned),
    in_progress: toNumber(row.in_progress),
  }))

  return {
    total,
    online,
    busy,
    idle,
    offline,
    busy_ratio: online > 0 ? Math.round((busy / online) * 100) / 100 : 0,
    load_distribution: loadDist,
  };
}

type RecommendationLevel = 'normal' | 'throttle' | 'shed' | 'pause';

interface Recommendation {
  action: RecommendationLevel;
  reason: string;
  details: string[];
  submit_ok: boolean;
  suggested_delay_ms: number;
}

function computeRecommendation(
  capacity: CapacityMetrics,
  queue: QueueMetrics,
  agents: AgentMetrics
): Recommendation {
  const reasons: string[] = [];
  let level: RecommendationLevel = 'normal';

  // Check error rate
  if (capacity.error_rate_5m >= THRESHOLDS.error_rate_shed) {
    level = escalate(level, 'shed');
    reasons.push(`High error rate: ${(capacity.error_rate_5m * 100).toFixed(1)}%`);
  } else if (capacity.error_rate_5m >= THRESHOLDS.error_rate_throttle) {
    level = escalate(level, 'throttle');
    reasons.push(`Elevated error rate: ${(capacity.error_rate_5m * 100).toFixed(1)}%`);
  }

  // Check queue depth
  if (queue.total_pending >= THRESHOLDS.queue_depth_shed) {
    level = escalate(level, 'shed');
    reasons.push(`Queue depth critical: ${queue.total_pending} pending tasks`);
  } else if (queue.total_pending >= THRESHOLDS.queue_depth_throttle) {
    level = escalate(level, 'throttle');
    reasons.push(`Queue depth high: ${queue.total_pending} pending tasks`);
  }

  // Check agent saturation
  if (agents.busy_ratio >= THRESHOLDS.busy_agent_ratio_shed) {
    level = escalate(level, 'shed');
    reasons.push(`Agent saturation critical: ${(agents.busy_ratio * 100).toFixed(0)}% busy`);
  } else if (agents.busy_ratio >= THRESHOLDS.busy_agent_ratio_throttle) {
    level = escalate(level, 'throttle');
    reasons.push(`Agent saturation high: ${(agents.busy_ratio * 100).toFixed(0)}% busy`);
  }

  // No online agents = pause
  if (agents.online === 0) {
    level = 'pause';
    reasons.push(agents.total > 0 ? 'No agents online' : 'No agents registered');
  }

  const delayMap: Record<RecommendationLevel, number> = {
    normal: 0,
    throttle: 2000,
    shed: 10000,
    pause: 30000,
  };

  const actionDescriptions: Record<RecommendationLevel, string> = {
    normal: 'System healthy — submit work freely',
    throttle: 'System under load — reduce submission rate and defer non-critical work',
    shed: 'System overloaded — submit only critical/high-priority work, defer everything else',
    pause: 'System unavailable — hold all submissions until capacity returns',
  };

  return {
    action: level,
    reason: actionDescriptions[level],
    details: reasons.length > 0 ? reasons : ['All metrics within normal bounds'],
    submit_ok: level === 'normal' || level === 'throttle',
    suggested_delay_ms: delayMap[level],
  };
}

function escalate(current: RecommendationLevel, proposed: RecommendationLevel): RecommendationLevel {
  const order: RecommendationLevel[] = ['normal', 'throttle', 'shed', 'pause'];
  return order.indexOf(proposed) > order.indexOf(current) ? proposed : current;
}
