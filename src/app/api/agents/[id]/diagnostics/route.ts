import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { getPrismaClient } from '@/lib/prisma';

const ALLOWED_SECTIONS = ['summary', 'tasks', 'errors', 'activity', 'trends', 'tokens'] as const;
type DiagnosticsSection = (typeof ALLOWED_SECTIONS)[number];

function parseHoursParam(raw: string | null): { value?: number; error?: string } {
  if (raw === null) return { value: 24 };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    return { error: 'hours must be an integer between 1 and 720' };
  }
  if (parsed < 1 || parsed > 720) {
    return { error: 'hours must be between 1 and 720' };
  }
  return { value: parsed };
}

function parseSectionsParam(raw: string | null): { value?: Set<DiagnosticsSection>; error?: string } {
  if (!raw || raw.trim().length === 0) {
    return { value: new Set(ALLOWED_SECTIONS) };
  }

  const requested = raw
    .split(',')
    .map((section) => section.trim())
    .filter(Boolean);

  if (requested.length === 0) {
    return { error: 'section must include at least one valid value' };
  }

  const invalid = requested.filter((section) => !ALLOWED_SECTIONS.includes(section as DiagnosticsSection));
  if (invalid.length > 0) {
    return { error: `Invalid section value(s): ${invalid.join(', ')}` };
  }

  return { value: new Set(requested as DiagnosticsSection[]) };
}

/**
 * GET /api/agents/[id]/diagnostics - Agent Self-Diagnostics API
 *
 * Provides an agent with its own performance metrics, error analysis,
 * and trend data so it can self-optimize.
 *
 * Query params:
 *   hours   - Time window in hours (default: 24, max: 720 = 30 days)
 *   section - Comma-separated sections to include (default: all)
 *             Options: summary, tasks, errors, activity, trends, tokens
 *
 * Response includes:
 *   summary     - High-level KPIs (throughput, error rate, activity count)
 *   tasks       - Task completion breakdown by status and priority
 *   errors      - Error frequency, types, and recent error details
 *   activity    - Activity breakdown by type with hourly timeline
 *   trends      - Multi-period comparison for trend detection
 *   tokens      - Token usage by model with cost estimates
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
    const agentId = resolvedParams.id;
    const workspaceId = auth.user.workspace_id ?? 1;

    // Resolve agent by ID or name
    let agent: any;
    if (/^\d+$/.test(agentId)) {
      agent = await prisma.agents.findFirst({
        where: { id: Number(agentId), workspace_id: workspaceId },
        select: { id: true, name: true, role: true, status: true, last_seen: true, created_at: true },
      })
    } else {
      agent = await prisma.agents.findFirst({
        where: { name: agentId, workspace_id: workspaceId },
        select: { id: true, name: true, role: true, status: true, last_seen: true, created_at: true },
      })
    }

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const requesterAgentName = auth.user.agent_name?.trim() || '';
    const privileged = searchParams.get('privileged') === '1';
    const isSelfRequest = (requesterAgentName || auth.user.username) === agent.name;

    // Self-only by default. Cross-agent access requires explicit privileged override.
    if (!isSelfRequest && !(privileged && auth.user.role === 'admin')) {
      return NextResponse.json(
        { error: 'Diagnostics are self-scoped. Use privileged=1 with admin role for cross-agent access.' },
        { status: 403 }
      );
    }

    const parsedHours = parseHoursParam(searchParams.get('hours'));
    if (parsedHours.error) {
      return NextResponse.json({ error: parsedHours.error }, { status: 400 });
    }

    const parsedSections = parseSectionsParam(searchParams.get('section'));
    if (parsedSections.error) {
      return NextResponse.json({ error: parsedSections.error }, { status: 400 });
    }

    const hours = parsedHours.value as number;
    const sections = parsedSections.value as Set<DiagnosticsSection>;

    const now = Math.floor(Date.now() / 1000);
    const since = now - hours * 3600;

    const result: Record<string, any> = {
      agent: { id: agent.id, name: agent.name, role: agent.role, status: agent.status },
      timeframe: { hours, since, until: now },
    };

    if (sections.has('summary')) {
      result.summary = await buildSummary(prisma, agent.name, workspaceId, since);
    }

    if (sections.has('tasks')) {
      result.tasks = await buildTaskMetrics(prisma, agent.name, workspaceId, since);
    }

    if (sections.has('errors')) {
      result.errors = await buildErrorAnalysis(prisma, agent.name, workspaceId, since);
    }

    if (sections.has('activity')) {
      result.activity = await buildActivityBreakdown(prisma, agent.name, workspaceId, since);
    }

    if (sections.has('trends')) {
      result.trends = await buildTrends(prisma, agent.name, workspaceId, hours);
    }

    if (sections.has('tokens')) {
      result.tokens = await buildTokenMetrics(prisma, agent.name, workspaceId, since);
    }

    return NextResponse.json(result);
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/diagnostics error');
    return NextResponse.json({ error: 'Failed to fetch diagnostics' }, { status: 500 });
  }
}

/** High-level KPIs */
async function buildSummary(prisma: any, agentName: string, workspaceId: number, since: number) {
  const [tasksDone, tasksTotal, activityCount, errorCount] = await Promise.all([
    prisma.tasks.count({
      where: { assigned_to: agentName, workspace_id: workspaceId, status: 'done', updated_at: { gte: since } },
    }),
    prisma.tasks.count({
      where: { assigned_to: agentName, workspace_id: workspaceId },
    }),
    prisma.activities.count({
      where: { actor: agentName, workspace_id: workspaceId, created_at: { gte: since } },
    }),
    prisma.activities.count({
      where: {
        actor: agentName,
        workspace_id: workspaceId,
        created_at: { gte: since },
        type: { contains: 'error' },
      },
    }),
  ])

  const errorRate = activityCount > 0 ? Math.round((errorCount / activityCount) * 10000) / 100 : 0;

  return {
    tasks_completed: tasksDone,
    tasks_total: tasksTotal,
    activity_count: activityCount,
    error_count: errorCount,
    error_rate_percent: errorRate,
  };
}

/** Task completion breakdown */
async function buildTaskMetrics(prisma: any, agentName: string, workspaceId: number, since: number) {
  const [byStatus, byPriority, recentCompleted] = await Promise.all([
    prisma.tasks.groupBy({
      by: ['status'],
      where: { assigned_to: agentName, workspace_id: workspaceId },
      _count: { _all: true },
    }),
    prisma.tasks.groupBy({
      by: ['priority'],
      where: { assigned_to: agentName, workspace_id: workspaceId },
      _count: { _all: true },
    }),
    prisma.tasks.findMany({
      where: { assigned_to: agentName, workspace_id: workspaceId, status: 'done', updated_at: { gte: since } },
      select: { id: true, title: true, priority: true, updated_at: true },
      orderBy: { updated_at: 'desc' },
      take: 10,
    }),
  ])

  // Estimate throughput: tasks completed per day in the window
  const windowDays = Math.max((Math.floor(Date.now() / 1000) - since) / 86400, 1);
  const completedInWindow = recentCompleted.length;
  const throughputPerDay = Math.round((completedInWindow / windowDays) * 100) / 100;

  return {
    by_status: Object.fromEntries(byStatus.map((r: any) => [r.status, r._count?._all ?? 0])),
    by_priority: Object.fromEntries(byPriority.map((r: any) => [r.priority, r._count?._all ?? 0])),
    recent_completed: recentCompleted,
    throughput_per_day: throughputPerDay,
  };
}

/** Error frequency and analysis */
async function buildErrorAnalysis(prisma: any, agentName: string, workspaceId: number, since: number) {
  const [errorActivities, recentErrors] = await Promise.all([
    prisma.activities.groupBy({
      by: ['type'],
      where: {
        actor: agentName,
        workspace_id: workspaceId,
        created_at: { gte: since },
        OR: [{ type: { contains: 'error' } }, { type: { contains: 'fail' } }],
      },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    }),
    prisma.activities.findMany({
      where: {
        actor: agentName,
        workspace_id: workspaceId,
        created_at: { gte: since },
        OR: [{ type: { contains: 'error' } }, { type: { contains: 'fail' } }],
      },
      select: { id: true, type: true, description: true, data: true, created_at: true },
      orderBy: { created_at: 'desc' },
      take: 20,
    }),
  ])

  return {
    by_type: errorActivities.map((row: any) => ({ type: row.type, count: row._count?.id ?? 0 })),
    total: errorActivities.reduce((sum: number, e: any) => sum + (e._count?.id ?? 0), 0),
    recent: recentErrors.map((e: any) => ({
      ...e,
      data: e.data ? JSON.parse(e.data) : null,
    })),
  };
}

/** Activity breakdown with hourly timeline */
async function buildActivityBreakdown(prisma: any, agentName: string, workspaceId: number, since: number) {
  const activities = await prisma.activities.findMany({
    where: { actor: agentName, workspace_id: workspaceId, created_at: { gte: since } },
    select: { type: true, created_at: true },
    orderBy: { created_at: 'asc' },
  })

  const byType = new Map<string, number>()
  const byHour = new Map<number, number>()
  for (const activity of activities) {
    byType.set(activity.type, (byType.get(activity.type) ?? 0) + 1)
    const bucket = Math.floor(activity.created_at / 3600) * 3600
    byHour.set(bucket, (byHour.get(bucket) ?? 0) + 1)
  }

  const byTypeRows = Array.from(byType.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)

  const timeline = Array.from(byHour.entries())
    .map(([hour_bucket, count]) => ({ hour_bucket, count }))
    .sort((a, b) => a.hour_bucket - b.hour_bucket)

  return {
    by_type: byTypeRows,
    timeline: timeline.map(t => ({
      timestamp: t.hour_bucket,
      hour: new Date(t.hour_bucket * 1000).toISOString(),
      count: t.count,
    })),
  };
}

/** Multi-period trend comparison for anomaly/trend detection */
async function buildTrends(prisma: any, agentName: string, workspaceId: number, hours: number) {
  const now = Math.floor(Date.now() / 1000);

  // Compare current period vs previous period of same length
  const currentSince = now - hours * 3600;
  const previousSince = currentSince - hours * 3600;

  const periodMetrics = async (since: number, until: number) => {
    const [activities, errors, tasksCompleted] = await Promise.all([
      prisma.activities.count({
        where: { actor: agentName, workspace_id: workspaceId, created_at: { gte: since, lt: until } },
      }),
      prisma.activities.count({
        where: {
          actor: agentName,
          workspace_id: workspaceId,
          created_at: { gte: since, lt: until },
          OR: [{ type: { contains: 'error' } }, { type: { contains: 'fail' } }],
        },
      }),
      prisma.tasks.count({
        where: { assigned_to: agentName, workspace_id: workspaceId, status: 'done', updated_at: { gte: since, lt: until } },
      }),
    ])
    return { activities, errors, tasks_completed: tasksCompleted };
  };

  const current = await periodMetrics(currentSince, now);
  const previous = await periodMetrics(previousSince, currentSince);

  const pctChange = (cur: number, prev: number) => {
    if (prev === 0) return cur > 0 ? 100 : 0;
    return Math.round(((cur - prev) / prev) * 10000) / 100;
  };

  return {
    current_period: { since: currentSince, until: now, ...current },
    previous_period: { since: previousSince, until: currentSince, ...previous },
    change: {
      activities_pct: pctChange(current.activities, previous.activities),
      errors_pct: pctChange(current.errors, previous.errors),
      tasks_completed_pct: pctChange(current.tasks_completed, previous.tasks_completed),
    },
    alerts: buildTrendAlerts(current, previous),
  };
}

/** Generate automatic alerts from trend data */
function buildTrendAlerts(current: { activities: number; errors: number; tasks_completed: number }, previous: { activities: number; errors: number; tasks_completed: number }) {
  const alerts: Array<{ level: string; message: string }> = [];

  // Error rate spike
  if (current.errors > 0 && previous.errors > 0) {
    const errorIncrease = (current.errors - previous.errors) / previous.errors;
    if (errorIncrease > 0.5) {
      alerts.push({ level: 'warning', message: `Error count increased ${Math.round(errorIncrease * 100)}% vs previous period` });
    }
  } else if (current.errors > 3 && previous.errors === 0) {
    alerts.push({ level: 'warning', message: `New error pattern: ${current.errors} errors (none in previous period)` });
  }

  // Throughput drop
  if (previous.tasks_completed > 0 && current.tasks_completed === 0) {
    alerts.push({ level: 'info', message: 'No tasks completed in current period (possible stall)' });
  } else if (previous.tasks_completed > 2 && current.tasks_completed < previous.tasks_completed * 0.5) {
    alerts.push({ level: 'info', message: `Task throughput dropped ${Math.round((1 - current.tasks_completed / previous.tasks_completed) * 100)}%` });
  }

  // Activity drop (possible offline)
  if (previous.activities > 5 && current.activities < previous.activities * 0.25) {
    alerts.push({ level: 'warning', message: `Activity dropped ${Math.round((1 - current.activities / previous.activities) * 100)}% — agent may be stalled` });
  }

  return alerts;
}

/** Token usage by model */
async function buildTokenMetrics(prisma: any, agentName: string, workspaceId: number, since: number) {
  try {
    // session_id on token_usage may store agent name or session key
    const byModel = await prisma.token_usage.groupBy({
      by: ['model'],
      where: { session_id: agentName, workspace_id: workspaceId, created_at: { gte: since } },
      _sum: { input_tokens: true, output_tokens: true },
      _count: { _all: true },
      orderBy: { _sum: { input_tokens: 'desc' } },
    })

    const rows = byModel.map((row: any) => ({
      model: row.model,
      input_tokens: row._sum?.input_tokens ?? 0,
      output_tokens: row._sum?.output_tokens ?? 0,
      request_count: row._count?._all ?? 0,
    })).sort((a: any, b: any) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens))

    const total = rows.reduce((acc: any, r: any) => ({
      input_tokens: acc.input_tokens + r.input_tokens,
      output_tokens: acc.output_tokens + r.output_tokens,
      requests: acc.requests + r.request_count,
    }), { input_tokens: 0, output_tokens: 0, requests: 0 });

    return {
      by_model: rows,
      total,
    };
  } catch {
    // token_usage table may not exist
    return { by_model: [], total: { input_tokens: 0, output_tokens: 0, requests: 0 } };
  }
}
