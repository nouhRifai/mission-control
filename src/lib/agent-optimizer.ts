/**
 * Agent Optimizer — token efficiency analysis and fleet benchmarking.
 *
 * Queries token_usage, tasks, mcp_call_log, and agent_trust_scores
 * to produce actionable recommendations for reducing agent cost and latency.
 */

import { getPrismaClient } from '@/lib/prisma'

export interface TokenEfficiency {
  agentName: string
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalCostUsd: number
  sessionsCount: number
  avgTokensPerSession: number
  avgCostPerSession: number
}

export interface ToolPatterns {
  agentName: string
  totalCalls: number
  uniqueTools: number
  topTools: Array<{ toolName: string; count: number; successRate: number }>
  failureRate: number
  avgDurationMs: number
}

export interface FleetBenchmark {
  agentName: string
  tokensPerTask: number
  costPerTask: number
  tasksCompleted: number
  trustScore: number
  toolCallsPerTask: number
}

export interface Recommendation {
  category: 'cost' | 'efficiency' | 'reliability' | 'trust'
  severity: 'info' | 'warning' | 'critical'
  message: string
  metric?: number
}

export async function analyzeTokenEfficiency(
  agentName: string,
  hours: number = 24,
  workspaceId: number = 1,
): Promise<TokenEfficiency> {
  const prisma = getPrismaClient()
  const since = Math.floor(Date.now() / 1000) - hours * 3600

  // Note: keep behavior aligned with the legacy SQL (no workspace_id filter here).
  const where = { agent_name: agentName, created_at: { gt: since } } as const

  const [sessions, sums] = await Promise.all([
    prisma.token_usage.count({ where }),
    prisma.token_usage.aggregate({
      where,
      _sum: {
        input_tokens: true,
        output_tokens: true,
        cost_usd: true,
      },
    }),
  ])

  const inputTokens = sums._sum.input_tokens ?? 0
  const outputTokens = sums._sum.output_tokens ?? 0
  const totalTokens = inputTokens + outputTokens

  return {
    agentName,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    totalTokens,
    totalCostUsd: Math.round(((sums._sum.cost_usd ?? 0) as number) * 10000) / 10000,
    sessionsCount: sessions,
    avgTokensPerSession: sessions > 0 ? Math.round(totalTokens / sessions) : 0,
    avgCostPerSession: sessions > 0
      ? Math.round((((sums._sum.cost_usd ?? 0) as number) / sessions) * 10000) / 10000
      : 0,
  }
}

export async function analyzeToolPatterns(
  agentName: string,
  hours: number = 24,
  workspaceId: number = 1,
): Promise<ToolPatterns> {
  const prisma = getPrismaClient()
  const since = Math.floor(Date.now() / 1000) - hours * 3600

  const where = {
    agent_name: agentName,
    workspace_id: workspaceId,
    created_at: { gt: since },
  } as const

  const [total, failures, avgDuration, uniqueToolRows, topTools] = await Promise.all([
    prisma.mcp_call_log.count({ where }),
    prisma.mcp_call_log.count({ where: { ...where, success: 0 } }),
    prisma.mcp_call_log.aggregate({ where, _avg: { duration_ms: true } }),
    prisma.mcp_call_log.findMany({
      where: { ...where, tool_name: { not: null } },
      distinct: ['tool_name'],
      select: { tool_name: true },
    }),
    prisma.mcp_call_log.groupBy({
      by: ['tool_name'],
      where,
      _count: { id: true },
      _sum: { success: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }),
  ])

  return {
    agentName,
    totalCalls: total,
    uniqueTools: uniqueToolRows.length,
    topTools: topTools.map((t: any) => {
      const count = t._count?.id ?? 0
      const successes = t._sum?.success ?? 0
      const successRate = count > 0 ? (successes / count) * 100 : 0
      return {
        toolName: t.tool_name ?? 'unknown',
        count,
        successRate: Math.round(successRate * 100) / 100,
      }
    }),
    failureRate: total > 0 ? Math.round((failures / total) * 10000) / 100 : 0,
    avgDurationMs: Math.round(avgDuration._avg.duration_ms ?? 0),
  }
}

export async function getFleetBenchmarks(workspaceId: number = 1): Promise<FleetBenchmark[]> {
  const prisma = getPrismaClient()

  const [agents, trusts, tokenSums, distinctTasks, toolCalls] = await Promise.all([
    prisma.agent_trust_scores.findMany({
      where: { workspace_id: workspaceId },
      select: { agent_name: true },
    }),
    prisma.agent_trust_scores.findMany({
      where: { workspace_id: workspaceId },
      select: { agent_name: true, trust_score: true },
    }),
    // Legacy behavior: token_usage is not workspace-scoped here.
    prisma.token_usage.groupBy({
      by: ['agent_name'],
      where: { task_id: { not: null }, agent_name: { not: null } },
      _sum: { input_tokens: true, output_tokens: true, cost_usd: true },
    }),
    prisma.token_usage.groupBy({
      by: ['agent_name', 'task_id'],
      where: { task_id: { not: null }, agent_name: { not: null } },
      _count: { _all: true },
    }),
    prisma.mcp_call_log.groupBy({
      by: ['agent_name'],
      where: { workspace_id: workspaceId, agent_name: { not: null } },
      _count: { _all: true },
    }),
  ])

  const trustByAgent = new Map(trusts.map(t => [t.agent_name, t.trust_score]))

  const tokenByAgent = new Map(
    tokenSums.map((t: any) => [
      t.agent_name,
      {
        input: t._sum?.input_tokens ?? 0,
        output: t._sum?.output_tokens ?? 0,
        cost: t._sum?.cost_usd ?? 0,
      },
    ])
  )

  const tasksCompletedByAgent = new Map<string, number>()
  for (const row of distinctTasks as any[]) {
    const name = row.agent_name as string
    tasksCompletedByAgent.set(name, (tasksCompletedByAgent.get(name) ?? 0) + 1)
  }

  const toolCallsByAgent = new Map<string, number>()
  for (const row of toolCalls as any[]) {
    toolCallsByAgent.set(row.agent_name as string, row._count?._all ?? 0)
  }

  // agent_trust_scores is unique on (agent_name, workspace_id), so this list is already distinct.
  const agentNames = agents.map(a => a.agent_name)

  return agentNames.map((agentName) => {
    const sums = tokenByAgent.get(agentName) ?? { input: 0, output: 0, cost: 0 }
    const tasksCompleted = tasksCompletedByAgent.get(agentName) ?? 0
    const totalTokens = (sums.input ?? 0) + (sums.output ?? 0)
    const cost = sums.cost ?? 0
    const trustScore = trustByAgent.get(agentName) ?? 1.0
    const toolCallsCount = toolCallsByAgent.get(agentName) ?? 0

    const tokensPerTask = tasksCompleted > 0 ? totalTokens / tasksCompleted : 0
    const costPerTask = tasksCompleted > 0 ? cost / tasksCompleted : 0
    const toolCallsPerTask = tasksCompleted > 0 ? toolCallsCount / tasksCompleted : 0

    return {
      agentName,
      tokensPerTask: Math.round(tokensPerTask),
      costPerTask: Math.round(costPerTask * 10000) / 10000,
      tasksCompleted,
      trustScore: Math.round(trustScore * 100) / 100,
      toolCallsPerTask: Math.round(toolCallsPerTask * 10) / 10,
    }
  })
}

export async function generateRecommendations(
  agentName: string,
  workspaceId: number = 1,
): Promise<Recommendation[]> {
  const prisma = getPrismaClient()
  const recommendations: Recommendation[] = []

  // Check trust score
  const trust = await prisma.agent_trust_scores.findFirst({
    where: { agent_name: agentName, workspace_id: workspaceId },
  })

  if (trust) {
    if (trust.trust_score < 0.5) {
      recommendations.push({
        category: 'trust',
        severity: 'critical',
        message: `Trust score is critically low (${trust.trust_score.toFixed(2)}). Review security events.`,
        metric: trust.trust_score,
      })
    } else if (trust.trust_score < 0.8) {
      recommendations.push({
        category: 'trust',
        severity: 'warning',
        message: `Trust score is below threshold (${trust.trust_score.toFixed(2)}). Monitor for anomalies.`,
        metric: trust.trust_score,
      })
    }

    if (trust.injection_attempts > 0) {
      recommendations.push({
        category: 'trust',
        severity: 'critical',
        message: `${trust.injection_attempts} injection attempt(s) detected. Investigate immediately.`,
        metric: trust.injection_attempts,
      })
    }
  }

  // Check tool failure rate
  const since = Math.floor(Date.now() / 1000) - 86400
  const toolWhere = { agent_name: agentName, workspace_id: workspaceId, created_at: { gt: since } } as const
  const [toolTotal, toolFailures] = await Promise.all([
    prisma.mcp_call_log.count({ where: toolWhere }),
    prisma.mcp_call_log.count({ where: { ...toolWhere, success: 0 } }),
  ])

  if (toolTotal > 10) {
    const failRate = toolFailures / toolTotal
    if (failRate > 0.3) {
      recommendations.push({
        category: 'reliability',
        severity: 'warning',
        message: `Tool failure rate is ${(failRate * 100).toFixed(1)}% in the last 24h. Check failing tools.`,
        metric: failRate,
      })
    }
  }

  // Check token efficiency vs fleet average
  // Legacy behavior: token_usage is not workspace-scoped here.
  const [agentCostAgg, agentTaskIds, fleetCostAgg, fleetTaskPairs] = await Promise.all([
    prisma.token_usage.aggregate({
      where: { agent_name: agentName, task_id: { not: null } },
      _sum: { cost_usd: true },
    }),
    prisma.token_usage.findMany({
      where: { agent_name: agentName, task_id: { not: null } },
      distinct: ['task_id'],
      select: { task_id: true },
    }),
    prisma.token_usage.groupBy({
      by: ['agent_name'],
      where: { agent_name: { not: null }, task_id: { not: null } },
      _sum: { cost_usd: true },
    }),
    prisma.token_usage.groupBy({
      by: ['agent_name', 'task_id'],
      where: { agent_name: { not: null }, task_id: { not: null } },
      _count: { _all: true },
    }),
  ])

  const agentTasks = agentTaskIds.length
  const agentCost = (agentCostAgg._sum.cost_usd ?? 0) as number

  const tasksByAgent = new Map<string, number>()
  for (const row of fleetTaskPairs as any[]) {
    const name = row.agent_name as string
    tasksByAgent.set(name, (tasksByAgent.get(name) ?? 0) + 1)
  }

  let sumCostPerTask = 0
  let agentsWithTasks = 0
  for (const row of fleetCostAgg as any[]) {
    const name = row.agent_name as string
    const cost = (row._sum?.cost_usd ?? 0) as number
    const tasks = tasksByAgent.get(name) ?? 0
    if (tasks > 0) {
      sumCostPerTask += cost / tasks
      agentsWithTasks += 1
    }
  }

  const fleetAvgCost = agentsWithTasks > 0 ? sumCostPerTask / agentsWithTasks : 0

  if (agentTasks > 0 && fleetAvgCost > 0) {
    const agentCostPerTask = agentCost / agentTasks
    if (agentCostPerTask > fleetAvgCost * 2) {
      recommendations.push({
        category: 'cost',
        severity: 'warning',
        message: `Cost per task ($${agentCostPerTask.toFixed(4)}) is ${(agentCostPerTask / fleetAvgCost).toFixed(1)}x the fleet average.`,
        metric: agentCostPerTask,
      })
    }
  }

  return recommendations
}
