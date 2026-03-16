/**
 * Agent Evals — four-layer evaluation engine for agent performance.
 *
 * Layer 1 (Output): Task completion and correctness scoring
 * Layer 2 (Trace): Convergence analysis and reasoning coherence
 * Layer 3 (Component): Tool reliability from MCP call logs
 * Layer 4 (Drift): Rolling baseline comparison with threshold detection
 */

import { getPrismaClient } from '@/lib/prisma'

export type EvalLayer = 'output' | 'trace' | 'component' | 'drift'

export interface EvalResult {
  layer: EvalLayer
  score: number
  passed: boolean
  detail: string
}

export interface DriftResult {
  metric: string
  current: number
  baseline: number
  delta: number
  drifted: boolean
  threshold: number
}

// ---------------------------------------------------------------------------
// Layer 1: Output Evals
// ---------------------------------------------------------------------------

export function evalTaskCompletion(
  agentName: string,
  hours: number = 168,
  workspaceId: number = 1,
): Promise<EvalResult> {
  const prisma = getPrismaClient()
  const since = Math.floor(Date.now() / 1000) - hours * 3600

  return (async () => {
    const [total, completed] = await Promise.all([
      prisma.tasks.count({
        where: { assigned_to: agentName, workspace_id: workspaceId, created_at: { gt: since } },
      }),
      prisma.tasks.count({
        where: { assigned_to: agentName, workspace_id: workspaceId, created_at: { gt: since }, status: 'done' },
      }),
    ])

  const score = total > 0 ? completed / total : 1.0

  return {
    layer: 'output',
    score: Math.round(score * 100) / 100,
    passed: score >= 0.7,
    detail: `${completed}/${total} tasks completed (${(score * 100).toFixed(0)}%)`,
  }
  })()
}

export function evalCorrectnessScore(
  agentName: string,
  hours: number = 168,
  workspaceId: number = 1,
): Promise<EvalResult> {
  const prisma = getPrismaClient()
  const since = Math.floor(Date.now() / 1000) - hours * 3600

  return (async () => {
    const [total, successful, agg] = await Promise.all([
      prisma.tasks.count({
        where: { assigned_to: agentName, workspace_id: workspaceId, status: 'done', created_at: { gt: since } },
      }),
      prisma.tasks.count({
        where: {
          assigned_to: agentName,
          workspace_id: workspaceId,
          status: 'done',
          created_at: { gt: since },
          outcome: 'success',
        },
      }),
      prisma.tasks.aggregate({
        where: { assigned_to: agentName, workspace_id: workspaceId, status: 'done', created_at: { gt: since } },
        _avg: { feedback_rating: true },
      }),
    ])

  const successRate = total > 0 ? successful / total : 1.0
  const avgRating = agg?._avg?.feedback_rating
  // Blend success rate with feedback rating if available (normalized to 0-1 assuming 1-5 scale)
  const score = avgRating != null
    ? (successRate * 0.6 + ((avgRating - 1) / 4) * 0.4)
    : successRate

  return {
    layer: 'output',
    score: Math.round(score * 100) / 100,
    passed: score >= 0.6,
    detail: `Correctness: ${(score * 100).toFixed(0)}% (${successful}/${total} successful${avgRating != null ? `, avg rating ${avgRating.toFixed(1)}` : ''})`,
  }
  })()
}

export function runOutputEvals(
  agentName: string,
  hours: number = 168,
  workspaceId: number = 1,
): Promise<EvalResult[]> {
  return Promise.all([
    evalTaskCompletion(agentName, hours, workspaceId),
    evalCorrectnessScore(agentName, hours, workspaceId),
  ])
}

// ---------------------------------------------------------------------------
// Layer 2: Trace Evals
// ---------------------------------------------------------------------------

export function convergenceScore(
  totalToolCalls: number,
  uniqueTools: number,
): { score: number; looping: boolean } {
  if (uniqueTools === 0) return { score: 1.0, looping: false }
  const ratio = totalToolCalls / uniqueTools
  // ratio > 3.0 indicates looping behavior
  return {
    score: Math.round(Math.min(1.0, 3.0 / ratio) * 100) / 100,
    looping: ratio > 3.0,
  }
}

export function evalReasoningCoherence(
  agentName: string,
  hours: number = 24,
  workspaceId: number = 1,
): Promise<EvalResult> {
  const prisma = getPrismaClient()
  const since = Math.floor(Date.now() / 1000) - hours * 3600

	return (async () => {
	    const [total, uniqueRows] = await Promise.all([
	      prisma.mcp_call_log.count({
	        where: { agent_name: agentName, workspace_id: workspaceId, created_at: { gt: since } },
	      }),
	      prisma.mcp_call_log.findMany({
	        where: { agent_name: agentName, workspace_id: workspaceId, created_at: { gt: since }, tool_name: { not: null } },
	        distinct: ['tool_name'],
	        select: { tool_name: true },
	      }),
	    ])
	  const unique = uniqueRows.length
	  const { score, looping } = convergenceScore(total, unique)

  return {
    layer: 'trace',
    score,
    passed: !looping,
    detail: `Convergence: ${total} calls across ${unique} unique tools (ratio ${unique > 0 ? (total / unique).toFixed(1) : 'N/A'})${looping ? ' — LOOPING DETECTED' : ''}`,
  }
  })()
}

// ---------------------------------------------------------------------------
// Layer 3: Component Evals
// ---------------------------------------------------------------------------

export function evalToolReliability(
  agentName: string,
  hours: number = 24,
  workspaceId: number = 1,
): Promise<EvalResult> {
  const prisma = getPrismaClient()
  const since = Math.floor(Date.now() / 1000) - hours * 3600

  return (async () => {
    const [total, successes] = await Promise.all([
      prisma.mcp_call_log.count({
        where: { agent_name: agentName, workspace_id: workspaceId, created_at: { gt: since } },
      }),
      prisma.mcp_call_log.count({
        where: { agent_name: agentName, workspace_id: workspaceId, created_at: { gt: since }, success: 1 },
      }),
    ])
  const score = total > 0 ? successes / total : 1.0

  return {
    layer: 'component',
    score: Math.round(score * 100) / 100,
    passed: score >= 0.8,
    detail: `Tool reliability: ${successes}/${total} successful (${(score * 100).toFixed(0)}%)`,
  }
  })()
}

// ---------------------------------------------------------------------------
// Layer 4: Drift Detection
// ---------------------------------------------------------------------------

const DRIFT_THRESHOLD = 0.10

export function checkDrift(
  current: number,
  baseline: number,
  threshold: number = DRIFT_THRESHOLD,
): DriftResult {
  const delta = baseline !== 0
    ? Math.abs(current - baseline) / Math.abs(baseline)
    : current !== 0 ? 1.0 : 0.0

  return {
    metric: '',
    current,
    baseline,
    delta: Math.round(delta * 10000) / 10000,
    drifted: delta > threshold,
    threshold,
  }
}

export function runDriftCheck(
  agentName: string,
  workspaceId: number = 1,
): Promise<DriftResult[]> {
  const prisma = getPrismaClient()
  const now = Math.floor(Date.now() / 1000)
  const oneWeek = 7 * 86400
  const fourWeeks = 4 * 7 * 86400

  // Current window: last 7 days
  const currentStart = now - oneWeek
  // Baseline window: 4 weeks ending 1 week ago
  const baselineStart = now - fourWeeks
  const baselineEnd = currentStart

  return (async () => {
    // Metric: avg tokens per session
    const [currentTokens, baselineTokens] = await Promise.all([
      prisma.token_usage.aggregate({
        where: { agent_name: agentName, created_at: { gt: currentStart } },
        _avg: { input_tokens: true, output_tokens: true },
      }),
      prisma.token_usage.aggregate({
        where: { agent_name: agentName, created_at: { gt: baselineStart, lte: baselineEnd } },
        _avg: { input_tokens: true, output_tokens: true },
      }),
    ])

    const currentAvgTokens = (currentTokens?._avg?.input_tokens ?? 0) + (currentTokens?._avg?.output_tokens ?? 0)
    const baselineAvgTokens = (baselineTokens?._avg?.input_tokens ?? 0) + (baselineTokens?._avg?.output_tokens ?? 0)
    const tokenDrift = checkDrift(currentAvgTokens, baselineAvgTokens)
    tokenDrift.metric = 'avg_tokens_per_session'

    // Metric: tool success rate
    const [currentToolTotal, currentToolSuccess, baselineToolTotal, baselineToolSuccess] = await Promise.all([
      prisma.mcp_call_log.count({
        where: { agent_name: agentName, workspace_id: workspaceId, created_at: { gt: currentStart } },
      }),
      prisma.mcp_call_log.count({
        where: { agent_name: agentName, workspace_id: workspaceId, created_at: { gt: currentStart }, success: 1 },
      }),
      prisma.mcp_call_log.count({
        where: { agent_name: agentName, workspace_id: workspaceId, created_at: { gt: baselineStart, lte: baselineEnd } },
      }),
      prisma.mcp_call_log.count({
        where: { agent_name: agentName, workspace_id: workspaceId, created_at: { gt: baselineStart, lte: baselineEnd }, success: 1 },
      }),
    ])

    const currentSuccessRate = currentToolTotal > 0 ? currentToolSuccess / currentToolTotal : 1.0
    const baselineSuccessRate = baselineToolTotal > 0 ? baselineToolSuccess / baselineToolTotal : 1.0
    const toolDrift = checkDrift(currentSuccessRate, baselineSuccessRate)
    toolDrift.metric = 'tool_success_rate'

    // Metric: task completion rate
    const [currentTaskTotal, currentTaskDone, baselineTaskTotal, baselineTaskDone] = await Promise.all([
      prisma.tasks.count({
        where: { assigned_to: agentName, workspace_id: workspaceId, created_at: { gt: currentStart } },
      }),
      prisma.tasks.count({
        where: { assigned_to: agentName, workspace_id: workspaceId, created_at: { gt: currentStart }, status: 'done' },
      }),
      prisma.tasks.count({
        where: { assigned_to: agentName, workspace_id: workspaceId, created_at: { gt: baselineStart, lte: baselineEnd } },
      }),
      prisma.tasks.count({
        where: { assigned_to: agentName, workspace_id: workspaceId, created_at: { gt: baselineStart, lte: baselineEnd }, status: 'done' },
      }),
    ])

    const currentCompletionRate = currentTaskTotal > 0 ? currentTaskDone / currentTaskTotal : 1.0
    const baselineCompletionRate = baselineTaskTotal > 0 ? baselineTaskDone / baselineTaskTotal : 1.0
    const taskDrift = checkDrift(currentCompletionRate, baselineCompletionRate)
    taskDrift.metric = 'task_completion_rate'

    return [tokenDrift, toolDrift, taskDrift]
  })()
}

export function getDriftTimeline(
  agentName: string,
  weeks: number = 8,
  workspaceId: number = 1,
): Promise<Array<{ weekStart: number; avgTokens: number; successRate: number; completionRate: number }>> {
  const prisma = getPrismaClient()
  const now = Math.floor(Date.now() / 1000)
  const timeline: Array<{ weekStart: number; avgTokens: number; successRate: number; completionRate: number }> = []

  return (async () => {
    for (let i = weeks - 1; i >= 0; i--) {
      const weekStart = now - (i + 1) * 7 * 86400
      const weekEnd = now - i * 7 * 86400

      const [tokensAgg, toolTotal, toolSuccess, taskTotal, taskDone] = await Promise.all([
        prisma.token_usage.aggregate({
          where: { agent_name: agentName, created_at: { gt: weekStart, lte: weekEnd } },
          _avg: { input_tokens: true, output_tokens: true },
        }),
        prisma.mcp_call_log.count({
          where: { agent_name: agentName, workspace_id: workspaceId, created_at: { gt: weekStart, lte: weekEnd } },
        }),
        prisma.mcp_call_log.count({
          where: { agent_name: agentName, workspace_id: workspaceId, created_at: { gt: weekStart, lte: weekEnd }, success: 1 },
        }),
        prisma.tasks.count({
          where: { assigned_to: agentName, workspace_id: workspaceId, created_at: { gt: weekStart, lte: weekEnd } },
        }),
        prisma.tasks.count({
          where: { assigned_to: agentName, workspace_id: workspaceId, created_at: { gt: weekStart, lte: weekEnd }, status: 'done' },
        }),
      ])

      const avgTokens = (tokensAgg?._avg?.input_tokens ?? 0) + (tokensAgg?._avg?.output_tokens ?? 0)

      timeline.push({
        weekStart,
        avgTokens: Math.round(avgTokens),
        successRate: toolTotal > 0 ? Math.round((toolSuccess / toolTotal) * 10000) / 100 : 100,
        completionRate: taskTotal > 0 ? Math.round((taskDone / taskTotal) * 10000) / 100 : 100,
      })
    }

    return timeline
  })()
}
