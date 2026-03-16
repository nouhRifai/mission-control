/**
 * MCP Audit — logs and analyzes MCP tool calls per agent.
 *
 * Tracks every tool invocation with success/failure, duration, and error detail.
 * Provides aggregated stats for efficiency dashboards.
 */

import { getPrismaClient } from '@/lib/prisma'

export interface McpCallInput {
  agentName?: string
  mcpServer?: string
  toolName?: string
  success?: boolean
  durationMs?: number
  error?: string
  workspaceId?: number
}

export interface McpCallStats {
  totalCalls: number
  successCount: number
  failureCount: number
  successRate: number
  avgDurationMs: number
  toolBreakdown: Array<{
    toolName: string
    mcpServer: string
    calls: number
    successes: number
    failures: number
    avgDurationMs: number
  }>
}

export async function logMcpCall(input: McpCallInput): Promise<number> {
  const prisma = getPrismaClient()
  const createdAt = Math.floor(Date.now() / 1000)
  const created = await prisma.mcp_call_log.create({
    data: {
      agent_name: input.agentName ?? null,
      mcp_server: input.mcpServer ?? null,
      tool_name: input.toolName ?? null,
      success: input.success !== false ? 1 : 0,
      duration_ms: input.durationMs ?? null,
      error: input.error ?? null,
      workspace_id: input.workspaceId ?? 1,
      created_at: createdAt,
    },
    select: { id: true },
  })

  return created.id
}

export async function getMcpCallStats(
  agentName: string,
  hours: number = 24,
  workspaceId: number = 1,
): Promise<McpCallStats> {
  const prisma = getPrismaClient()
  const since = Math.floor(Date.now() / 1000) - hours * 3600

  const where = {
    agent_name: agentName,
    workspace_id: workspaceId,
    created_at: { gt: since },
  } as const

  const [totalCalls, successCount, failureCount, avgDuration, breakdown] = await Promise.all([
    prisma.mcp_call_log.count({ where }),
    prisma.mcp_call_log.count({ where: { ...where, success: 1 } }),
    prisma.mcp_call_log.count({ where: { ...where, success: 0 } }),
    prisma.mcp_call_log.aggregate({ where, _avg: { duration_ms: true } }),
    prisma.mcp_call_log.groupBy({
      by: ['tool_name', 'mcp_server'],
      where,
      _count: { id: true },
      _sum: { success: true },
      _avg: { duration_ms: true },
      orderBy: { _count: { id: 'desc' } },
    }),
  ])

  return {
    totalCalls,
    successCount,
    failureCount,
    successRate: totalCalls > 0 ? Math.round((successCount / totalCalls) * 10000) / 100 : 100,
    avgDurationMs: Math.round((avgDuration._avg.duration_ms ?? 0) as number),
    toolBreakdown: breakdown.map((row: any) => {
      const calls = row._count?.id ?? 0
      const successes = row._sum?.success ?? 0
      return {
        toolName: row.tool_name ?? 'unknown',
        mcpServer: row.mcp_server ?? 'unknown',
        calls,
        successes,
        failures: calls - successes,
        avgDurationMs: Math.round(row._avg?.duration_ms ?? 0),
      }
    }),
  }
}
