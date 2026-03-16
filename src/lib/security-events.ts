/**
 * Security Events — structured security event logging and agent trust scoring.
 *
 * Persists events to the security_events table and broadcasts via the event bus.
 * Trust scores are recalculated on each security event using weighted factors.
 */

import { eventBus, type EventType } from '@/lib/event-bus'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'

export type SecuritySeverity = 'info' | 'warning' | 'critical'

export interface SecurityEvent {
  event_type: string
  severity?: SecuritySeverity
  source?: string
  agent_name?: string
  detail?: string
  ip_address?: string
  workspace_id?: number
  tenant_id?: number
}

export interface SecurityPosture {
  score: number
  totalEvents: number
  criticalEvents: number
  warningEvents: number
  avgTrustScore: number
  recentIncidents: number
}

const TRUST_WEIGHTS: Record<string, { field: string; delta: number }> = {
  'auth.failure': { field: 'auth_failures', delta: -0.05 },
  'injection.attempt': { field: 'injection_attempts', delta: -0.15 },
  'rate_limit.hit': { field: 'rate_limit_hits', delta: -0.03 },
  'secret.exposure': { field: 'secret_exposures', delta: -0.20 },
  'task.success': { field: 'successful_tasks', delta: 0.02 },
  'task.failure': { field: 'failed_tasks', delta: -0.01 },
}

export async function logSecurityEvent(event: SecurityEvent): Promise<number> {
  const prisma = getPrismaClient()
  const severity = event.severity ?? 'info'
  const workspaceId = event.workspace_id ?? 1
  const tenantId = event.tenant_id ?? 1
  const now = Math.floor(Date.now() / 1000)

  const created = await prisma.security_events.create({
    data: {
      event_type: event.event_type,
      severity,
      source: event.source ?? null,
      agent_name: event.agent_name ?? null,
      detail: event.detail ?? null,
      ip_address: event.ip_address ?? null,
      workspace_id: workspaceId,
      tenant_id: tenantId,
      created_at: now,
    },
    select: { id: true },
  })

  eventBus.broadcast('security.event' as EventType, {
    id: created.id,
    ...event,
    severity,
    workspace_id: workspaceId,
    timestamp: now,
  })

  return created.id
}

export async function updateAgentTrustScore(
  agentName: string,
  eventType: string,
  workspaceId: number = 1,
): Promise<void> {
  const prisma = getPrismaClient()
  const weight = TRUST_WEIGHTS[eventType]
  const now = Math.floor(Date.now() / 1000)

  // Ensure row exists
  await prisma.agent_trust_scores.upsert({
    where: { agent_name_workspace_id: { agent_name: agentName, workspace_id: workspaceId } },
    create: { agent_name: agentName, workspace_id: workspaceId, updated_at: now },
    update: {},
    select: { id: true },
  })

  if (weight) {
    const counterField = weight.field as any
    await prisma.agent_trust_scores.update({
      where: { agent_name_workspace_id: { agent_name: agentName, workspace_id: workspaceId } },
      data: {
        [counterField]: { increment: 1 },
        updated_at: now,
      } as any,
      select: { id: true },
    })

    // Recalculate trust score (clamped 0..1)
    const row = await prisma.agent_trust_scores.findUnique({
      where: { agent_name_workspace_id: { agent_name: agentName, workspace_id: workspaceId } },
    }) as any

    if (row) {
      let score = 1.0
      score += (row.auth_failures || 0) * -0.05
      score += (row.injection_attempts || 0) * -0.15
      score += (row.rate_limit_hits || 0) * -0.03
      score += (row.secret_exposures || 0) * -0.20
      score += (row.successful_tasks || 0) * 0.02
      score += (row.failed_tasks || 0) * -0.01
      score = Math.max(0, Math.min(1, score))

      const isAnomaly = weight.delta < 0
      await prisma.agent_trust_scores.update({
        where: { agent_name_workspace_id: { agent_name: agentName, workspace_id: workspaceId } },
        data: {
          trust_score: score,
          last_anomaly_at: isAnomaly ? now : row.last_anomaly_at,
          updated_at: now,
        },
        select: { id: true },
      })
    }
  }
}

export async function getSecurityPosture(workspaceId: number = 1): Promise<SecurityPosture> {
  const prisma = getPrismaClient()
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400

  const [totalEvents, criticalEvents, warningEvents, recentIncidents, trustAgg] = await Promise.all([
    prisma.security_events.count({ where: { workspace_id: workspaceId } }),
    prisma.security_events.count({ where: { workspace_id: workspaceId, severity: 'critical' } }),
    prisma.security_events.count({ where: { workspace_id: workspaceId, severity: 'warning' } }),
    prisma.security_events.count({ where: { workspace_id: workspaceId, severity: { in: ['warning', 'critical'] }, created_at: { gt: oneDayAgo } } }),
    prisma.agent_trust_scores.aggregate({ where: { workspace_id: workspaceId }, _avg: { trust_score: true } }),
  ])

  const avgTrust = trustAgg._avg.trust_score ?? 1.0

  // Score: start at 100, deduct for incidents
  let score = 100
  score -= criticalEvents * 10
  score -= warningEvents * 3
  score -= recentIncidents * 2
  score = Math.round(Math.max(0, Math.min(100, score * avgTrust)))

  return {
    score,
    totalEvents,
    criticalEvents,
    warningEvents,
    avgTrustScore: Math.round(avgTrust * 100) / 100,
    recentIncidents,
  }
}
