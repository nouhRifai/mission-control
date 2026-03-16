import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { readLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { getSecurityPosture } from '@/lib/security-events'
import { runSecurityScan } from '@/lib/security-scan'
import { getPrismaClient } from '@/lib/prisma'

type Timeframe = 'hour' | 'day' | 'week' | 'month'

const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  hour: 3600,
  day: 86400,
  week: 7 * 86400,
  month: 30 * 86400,
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = readLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const { searchParams } = new URL(request.url)
    const timeframe = (searchParams.get('timeframe') || 'day') as Timeframe
    const eventTypeFilter = searchParams.get('event_type')
    const severityFilter = searchParams.get('severity')
    const agentFilter = searchParams.get('agent')
    const workspaceId = auth.user.workspace_id ?? 1

    const seconds = TIMEFRAME_SECONDS[timeframe] || TIMEFRAME_SECONDS.day
    const since = Math.floor(Date.now() / 1000) - seconds
    const prisma = getPrismaClient()

    // Infrastructure scan (same as onboarding security scan)
    const scan = runSecurityScan()

    // Event-based posture (incidents, trust scores)
    const eventPosture = await getSecurityPosture(workspaceId)

    // Blend: weighted average — 70% infrastructure config, 30% event history
    const blendedScore = Math.round(scan.score * 0.7 + eventPosture.score * 0.3)
    const level = blendedScore >= 90 ? 'hardened'
      : blendedScore >= 70 ? 'secure'
      : blendedScore >= 40 ? 'needs-attention'
      : 'at-risk'

    // Auth events
    const authEventsQuery = await prisma.security_events.findMany({
      where: {
        workspace_id: workspaceId,
        created_at: { gt: since },
        event_type: { in: ['auth.failure', 'auth.token_rotation', 'auth.access_denied'] },
      },
      orderBy: { created_at: 'desc' },
      take: 50,
      select: { event_type: true, severity: true, agent_name: true, detail: true, ip_address: true, created_at: true },
    }) as any[]

    const loginFailures = authEventsQuery.filter(e => e.event_type === 'auth.failure').length
    const tokenRotations = authEventsQuery.filter(e => e.event_type === 'auth.token_rotation').length
    const accessDenials = authEventsQuery.filter(e => e.event_type === 'auth.access_denied').length

    // Agent trust
    const agents = await prisma.agent_trust_scores.findMany({
      where: { workspace_id: workspaceId },
      orderBy: { trust_score: 'asc' },
      select: {
        agent_name: true,
        trust_score: true,
        last_anomaly_at: true,
        auth_failures: true,
        injection_attempts: true,
        rate_limit_hits: true,
        secret_exposures: true,
      },
    }) as any[]

    const flaggedCount = agents.filter((a: any) => a.trust_score < 0.8).length

    // Secret exposures
    const secretEvents = await prisma.security_events.findMany({
      where: { workspace_id: workspaceId, created_at: { gt: since }, event_type: 'secret.exposure' },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: { event_type: true, severity: true, agent_name: true, detail: true, created_at: true },
    }) as any[]

    // MCP audit summary
    const mcpTotals = (await prisma.$queryRaw<any[]>`
      SELECT
        COUNT(*) as total_calls,
        COUNT(DISTINCT tool_name) as unique_tools,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures
      FROM mcp_call_log
      WHERE workspace_id = ${workspaceId} AND created_at > ${since}
    `)[0] as any

    const topTools = await prisma.$queryRaw<any[]>`
      SELECT tool_name, COUNT(*) as count
      FROM mcp_call_log
      WHERE workspace_id = ${workspaceId} AND created_at > ${since}
      GROUP BY tool_name
      ORDER BY count DESC
      LIMIT 10
    `

    const toNumber = (v: any) => (typeof v === 'bigint' ? Number(v) : (Number.isFinite(Number(v)) ? Number(v) : 0))
    const totalCalls = toNumber(mcpTotals?.total_calls)
    const failureRate = totalCalls > 0
      ? Math.round((toNumber(mcpTotals?.failures) / totalCalls) * 10000) / 100
      : 0

    // Rate limit hits
    const rateLimitTotal = await prisma.security_events.count({
      where: { workspace_id: workspaceId, created_at: { gt: since }, event_type: 'rate_limit.hit' },
    })
    const rateLimitByIp = await prisma.$queryRaw<any[]>`
      SELECT ip_address, COUNT(*) as count
      FROM security_events
      WHERE workspace_id = ${workspaceId}
        AND created_at > ${since}
        AND event_type = 'rate_limit.hit'
        AND ip_address IS NOT NULL
      GROUP BY ip_address
      ORDER BY count DESC
      LIMIT 10
    `

    // Injection attempts
    const injectionEvents = await prisma.security_events.findMany({
      where: { workspace_id: workspaceId, created_at: { gt: since }, event_type: 'injection.attempt' },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: { event_type: true, severity: true, agent_name: true, detail: true, ip_address: true, created_at: true },
    }) as any[]

    // Timeline (bucketed by hour)
    const bucketSize = timeframe === 'hour' ? 300 : 3600
    const timelineWhere: any = {
      workspace_id: workspaceId,
      created_at: { gt: since },
      ...(eventTypeFilter ? { event_type: eventTypeFilter } : {}),
      ...(severityFilter ? { severity: severityFilter } : {}),
      ...(agentFilter ? { agent_name: agentFilter } : {}),
    }
    const timelineEvents = await prisma.security_events.findMany({
      where: timelineWhere,
      select: { created_at: true, severity: true },
    })
    const severityRank = (sev: string | null | undefined) => sev === 'critical' ? 3 : sev === 'warning' ? 2 : 1
    const buckets = new Map<number, { event_count: number; max_severity: number }>()
    for (const ev of timelineEvents as any[]) {
      const createdAt = Number(ev.created_at)
      if (!Number.isFinite(createdAt)) continue
      const bucket = Math.floor(createdAt / bucketSize) * bucketSize
      const current = buckets.get(bucket) || { event_count: 0, max_severity: 1 }
      current.event_count += 1
      current.max_severity = Math.max(current.max_severity, severityRank(ev.severity))
      buckets.set(bucket, current)
    }
    const timeline = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bucket, agg]) => ({ bucket, event_count: agg.event_count, max_severity: agg.max_severity }))

    const severityMap: Record<number, string> = { 3: 'critical', 2: 'warning', 1: 'info' }

    return NextResponse.json({
      posture: { score: blendedScore, level },
      scan: {
        score: scan.score,
        overall: scan.overall,
        categories: scan.categories,
      },
      authEvents: {
        loginFailures,
        tokenRotations,
        accessDenials,
        recentEvents: authEventsQuery.slice(0, 10),
      },
      agentTrust: {
        agents: agents.map((a: any) => ({
          name: a.agent_name,
          score: Math.round(a.trust_score * 100) / 100,
          anomalies: (a.auth_failures || 0) + (a.injection_attempts || 0) + (a.rate_limit_hits || 0) + (a.secret_exposures || 0),
        })),
        flaggedCount,
      },
      secretExposures: {
        total: secretEvents.length,
        recent: secretEvents.slice(0, 5),
      },
      mcpAudit: {
        totalCalls,
        uniqueTools: toNumber(mcpTotals?.unique_tools),
        failureRate,
        topTools: topTools.map((t: any) => ({ name: t.tool_name, count: toNumber(t.count) })),
      },
      rateLimits: {
        totalHits: rateLimitTotal,
        byIp: rateLimitByIp.map((r: any) => ({ ip: r.ip_address, count: r.count })),
      },
      injectionAttempts: {
        total: injectionEvents.length,
        recent: injectionEvents.slice(0, 5),
      },
      timeline: timeline.map((t: any) => ({
        timestamp: t.bucket,
        eventCount: t.event_count,
        severity: severityMap[t.max_severity] || 'info',
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/security-audit error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
