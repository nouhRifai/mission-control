import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { getPrismaClient } from '@/lib/prisma';

const ALLOWED_SECTIONS = new Set(['identity', 'audit', 'mutations', 'cost']);

/**
 * GET /api/agents/[id]/attribution - Agent-Level Identity & Attribution
 *
 * Returns a comprehensive audit trail and cost attribution report for
 * a specific agent. Enables per-agent observability, debugging, and
 * cost analysis in multi-agent environments.
 *
 * Query params:
 *   hours   - Time window (default: 24, max: 720)
 *   section - Comma-separated: audit,cost,mutations,identity (default: all)
 *
 * Response:
 *   identity   - Agent profile, status, and session info
 *   audit      - Full audit trail of agent actions
 *   mutations  - Task/memory/soul changes attributed to this agent
 *   cost       - Token usage and cost breakdown per model
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

    // Resolve agent
    let agent: any;
    if (/^\d+$/.test(agentId)) {
      agent = await prisma.agents.findFirst({ where: { id: Number(agentId), workspace_id: workspaceId } })
    } else {
      agent = await prisma.agents.findFirst({ where: { name: agentId, workspace_id: workspaceId } })
    }

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const privileged = searchParams.get('privileged') === '1';
    const isSelfByHeader = auth.user.agent_name === agent.name;
    const isSelfByUsername = auth.user.username === agent.name;
    const isSelf = isSelfByHeader || isSelfByUsername;
    const isPrivileged = auth.user.role === 'admin' && privileged;
    if (!isSelf && !isPrivileged) {
      return NextResponse.json(
        { error: 'Forbidden: attribution is self-scope by default. Admin can use ?privileged=1 override.' },
        { status: 403 }
      );
    }

    const hoursRaw = searchParams.get('hours');
    const hours = parseHours(hoursRaw);
    if (!hours) {
      return NextResponse.json({ error: 'Invalid hours. Expected integer 1..720.' }, { status: 400 });
    }

    const sections = parseSections(searchParams.get('section'));
    if ('error' in sections) {
      return NextResponse.json({ error: sections.error }, { status: 400 });
    }

    const now = Math.floor(Date.now() / 1000);
    const since = now - hours * 3600;

    const result: Record<string, any> = {
      agent_name: agent.name,
      timeframe: { hours, since, until: now },
      access_scope: isSelf ? 'self' : 'privileged',
    };

    if (sections.sections.has('identity')) {
      result.identity = await buildIdentity(prisma, agent, workspaceId);
    }

    if (sections.sections.has('audit')) {
      result.audit = await buildAuditTrail(prisma, agent.name, workspaceId, since);
    }

    if (sections.sections.has('mutations')) {
      result.mutations = await buildMutations(prisma, agent.name, workspaceId, since);
    }

    if (sections.sections.has('cost')) {
      result.cost = await buildCostAttribution(prisma, agent.name, workspaceId, since);
    }

    return NextResponse.json(result);
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/attribution error');
    return NextResponse.json({ error: 'Failed to fetch attribution data' }, { status: 500 });
  }
}

/** Agent identity and profile info */
async function buildIdentity(prisma: any, agent: any, workspaceId: number) {
  const config = safeParseJson(agent.config, {});

  // Count total tasks ever assigned
  const [total, completed, active, commentCount] = await Promise.all([
    prisma.tasks.count({ where: { assigned_to: agent.name, workspace_id: workspaceId } }),
    prisma.tasks.count({ where: { assigned_to: agent.name, workspace_id: workspaceId, status: 'done' } }),
    prisma.tasks.count({
      where: { assigned_to: agent.name, workspace_id: workspaceId, status: { in: ['assigned', 'in_progress'] } },
    }),
    prisma.comments.count({ where: { author: agent.name, workspace_id: workspaceId } }),
  ])

  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    last_seen: agent.last_seen,
    last_activity: agent.last_activity,
    created_at: agent.created_at,
    session_key: agent.session_key ? '***' : null, // Masked for security
    has_soul: !!agent.soul_content,
    config_keys: Object.keys(config),
    lifetime_stats: {
      tasks_total: total || 0,
      tasks_completed: completed || 0,
      tasks_active: active || 0,
      comments_authored: commentCount,
    },
  };
}

/** Audit trail — all activities attributed to this agent */
async function buildAuditTrail(prisma: any, agentName: string, workspaceId: number, since: number) {
  // Activities where this agent is the actor
  const activities = await prisma.activities.findMany({
    where: { actor: agentName, workspace_id: workspaceId, created_at: { gte: since } },
    select: { id: true, type: true, entity_type: true, entity_id: true, description: true, data: true, created_at: true },
    orderBy: { created_at: 'desc' },
    take: 200,
  })

  // Audit log entries (system-wide, may reference agent)
  let auditEntries: any[] = [];
  try {
    auditEntries = await prisma.audit_log.findMany({
      where: {
        created_at: { gte: since },
        OR: [{ actor: agentName }, { detail: { contains: agentName } }],
      },
      select: { id: true, action: true, actor: true, detail: true, created_at: true },
      orderBy: { created_at: 'desc' },
      take: 100,
    })
  } catch {
    // audit_log table may not exist
  }

  // Group activities by type for summary
  const byType: Record<string, number> = {};
  for (const a of activities) {
    byType[a.type] = (byType[a.type] || 0) + 1;
  }

  return {
    total_activities: activities.length,
    by_type: byType,
    activities: activities.map((a: any) => ({
      ...a,
      data: safeParseJson(a.data, null),
    })),
    audit_log_entries: auditEntries.map((e: any) => ({
      ...e,
      detail: safeParseJson(e.detail, null),
    })),
  };
}

/** Mutations — task changes, comments, status transitions */
async function buildMutations(prisma: any, agentName: string, workspaceId: number, since: number) {
  // Task mutations (created, updated, status changes)
  const taskMutations = await prisma.activities.findMany({
    where: {
      actor: agentName,
      workspace_id: workspaceId,
      created_at: { gte: since },
      entity_type: 'task',
      type: { in: ['task_created', 'task_updated', 'task_status_change', 'task_assigned'] },
    },
    select: { id: true, type: true, entity_type: true, entity_id: true, description: true, data: true, created_at: true },
    orderBy: { created_at: 'desc' },
    take: 100,
  })

  // Comments authored
  const comments = await prisma.comments.findMany({
    where: { author: agentName, workspace_id: workspaceId, created_at: { gte: since } },
    select: {
      id: true,
      task_id: true,
      content: true,
      created_at: true,
      mentions: true,
      tasks: { select: { title: true } },
    },
    orderBy: { created_at: 'desc' },
    take: 50,
  })

  // Agent status changes (by heartbeat or others)
  const statusChanges = await prisma.activities.findMany({
    where: {
      entity_type: 'agent',
      workspace_id: workspaceId,
      created_at: { gte: since },
      OR: [{ actor: agentName }, { description: { contains: agentName } }],
    },
    select: { id: true, type: true, description: true, data: true, created_at: true },
    orderBy: { created_at: 'desc' },
    take: 50,
  })

  return {
    task_mutations: taskMutations.map((m: any) => ({
      ...m,
      data: safeParseJson(m.data, null),
    })),
    comments: comments.map((c: any) => ({
      ...c,
      task_title: (c as any).tasks?.title ?? null,
      mentions: safeParseJson(c.mentions, []),
      content_preview: c.content?.substring(0, 200) || '',
    })),
    status_changes: statusChanges.map((s: any) => ({
      ...s,
      data: safeParseJson(s.data, null),
    })),
    summary: {
      task_mutations_count: taskMutations.length,
      comments_count: comments.length,
      status_changes_count: statusChanges.length,
    },
  };
}

/** Cost attribution — token usage per model */
async function buildCostAttribution(prisma: any, agentName: string, workspaceId: number, since: number) {
  try {
    const [byModel, byModelAlt, dailyRows] = await Promise.all([
      prisma.token_usage.groupBy({
        by: ['model'],
        where: { session_id: agentName, workspace_id: workspaceId, created_at: { gte: since } },
        _sum: { input_tokens: true, output_tokens: true },
        _count: { _all: true },
      }),
      prisma.token_usage.groupBy({
        by: ['model'],
        where: {
          session_id: { startsWith: `${agentName}:` },
          workspace_id: workspaceId,
          created_at: { gte: since },
        },
        _sum: { input_tokens: true, output_tokens: true },
        _count: { _all: true },
      }),
      prisma.token_usage.findMany({
        where: {
          workspace_id: workspaceId,
          created_at: { gte: since },
          OR: [{ session_id: agentName }, { session_id: { startsWith: `${agentName}:` } }],
        },
        select: { created_at: true, input_tokens: true, output_tokens: true },
        orderBy: { created_at: 'asc' },
      }),
    ])

    const normalize = (rows: any[]) =>
      rows.map((row: any) => ({
        model: row.model,
        request_count: row._count?._all ?? 0,
        input_tokens: row._sum?.input_tokens ?? 0,
        output_tokens: row._sum?.output_tokens ?? 0,
      }))

    const byModelRows = normalize(byModel)
    const byModelAltRows = normalize(byModelAlt)

    // Merge results
    const merged = new Map<string, { model: string; request_count: number; input_tokens: number; output_tokens: number }>();
    for (const row of [...byModelRows, ...byModelAltRows]) {
      const existing = merged.get(row.model);
      if (existing) {
        existing.request_count += row.request_count;
        existing.input_tokens += row.input_tokens;
        existing.output_tokens += row.output_tokens;
      } else {
        merged.set(row.model, { ...row });
      }
    }

    const models = Array.from(merged.values());
    models.sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens))
    const total = models.reduce((acc, r) => ({
      input_tokens: acc.input_tokens + r.input_tokens,
      output_tokens: acc.output_tokens + r.output_tokens,
      requests: acc.requests + r.request_count,
    }), { input_tokens: 0, output_tokens: 0, requests: 0 });

    // Daily breakdown for trend
    const dailyByBucket = new Map<number, { day_bucket: number; input_tokens: number; output_tokens: number; requests: number }>()
    for (const row of dailyRows) {
      const bucket = Math.floor(row.created_at / 86400) * 86400
      const existing = dailyByBucket.get(bucket) ?? { day_bucket: bucket, input_tokens: 0, output_tokens: 0, requests: 0 }
      existing.input_tokens += row.input_tokens ?? 0
      existing.output_tokens += row.output_tokens ?? 0
      existing.requests += 1
      dailyByBucket.set(bucket, existing)
    }
    const daily = Array.from(dailyByBucket.values()).sort((a, b) => a.day_bucket - b.day_bucket)

    return {
      by_model: models,
      total,
      daily_trend: daily.map(d => ({
        date: new Date(d.day_bucket * 1000).toISOString().split('T')[0],
        ...d,
      })),
    };
  } catch {
    return { by_model: [], total: { input_tokens: 0, output_tokens: 0, requests: 0 }, daily_trend: [] };
  }
}

function parseHours(hoursRaw: string | null): number | null {
  if (!hoursRaw || hoursRaw.trim() === '') return 24;
  if (!/^\d+$/.test(hoursRaw)) return null;
  const hours = Number(hoursRaw);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) return null;
  return hours;
}

function parseSections(
  sectionRaw: string | null
): { sections: Set<string> } | { error: string } {
  const value = (sectionRaw || 'identity,audit,mutations,cost').trim();
  const parsed = value
    .split(',')
    .map((section) => section.trim())
    .filter(Boolean);

  if (parsed.length === 0) {
    return { error: 'Invalid section. Expected one or more of identity,audit,mutations,cost.' };
  }

  const invalid = parsed.filter((section) => !ALLOWED_SECTIONS.has(section));
  if (invalid.length > 0) {
    return { error: `Invalid section value(s): ${invalid.join(', ')}` };
  }

  return { sections: new Set(parsed) };
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
