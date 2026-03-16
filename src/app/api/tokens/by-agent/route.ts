import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { calculateTokenCost } from '@/lib/token-pricing'
import { getProviderSubscriptionFlags } from '@/lib/provider-subscriptions'
import { logger } from '@/lib/logger'
import { getPrismaClient, isPostgresProvider } from '@/lib/prisma'

interface AgentBreakdownRow {
  agent_name: string
  total_input_tokens: number
  total_output_tokens: number
  session_count: number
  request_count: number
  last_active: number
}

interface ModelBreakdown {
  model: string
  input_tokens: number
  output_tokens: number
  request_count: number
  cost: number
}

interface AgentBreakdown {
  agent: string
  total_input_tokens: number
  total_output_tokens: number
  total_tokens: number
  total_cost: number
  session_count: number
  request_count: number
  last_active: string
  models: ModelBreakdown[]
}

/**
 * GET /api/tokens/by-agent - Per-agent cost breakdown from token_usage table
 * Query params:
 *   days=N  - Time window in days (default 30)
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url)
    const days = Math.max(1, Math.min(365, Number(searchParams.get('days') || 30)))
    const workspaceId = auth.user.workspace_id ?? 1

    const prisma = getPrismaClient()
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400
    const providerSubscriptions = getProviderSubscriptionFlags()

    // Query per-agent totals with per-model breakdown embedded as JSON
    const rows = isPostgresProvider()
      ? ((await prisma.$queryRaw<any[]>`
          SELECT
            split_part(session_id, ':', 1) AS agent_name,
            SUM(input_tokens)  AS total_input_tokens,
            SUM(output_tokens) AS total_output_tokens,
            COUNT(DISTINCT session_id) AS session_count,
            COUNT(*)           AS request_count,
            MAX(created_at)    AS last_active
          FROM token_usage
          WHERE workspace_id = ${workspaceId}
            AND created_at >= ${cutoff}
          GROUP BY agent_name
          ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC
        `) as AgentBreakdownRow[])
      : ((await prisma.$queryRaw<any[]>`
          SELECT
            CASE
              WHEN INSTR(session_id, ':') > 0 THEN SUBSTR(session_id, 1, INSTR(session_id, ':') - 1)
              ELSE session_id
            END AS agent_name,
            SUM(input_tokens)  AS total_input_tokens,
            SUM(output_tokens) AS total_output_tokens,
            COUNT(DISTINCT session_id) AS session_count,
            COUNT(*)           AS request_count,
            MAX(created_at)    AS last_active
          FROM token_usage
          WHERE workspace_id = ${workspaceId}
            AND created_at >= ${cutoff}
          GROUP BY agent_name
          ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC
        `) as AgentBreakdownRow[])

    // For accurate per-model cost we need a second pass grouping by agent+model
    const modelRows = isPostgresProvider()
      ? ((await prisma.$queryRaw<any[]>`
          SELECT
            split_part(session_id, ':', 1) AS agent_name,
            model,
            SUM(input_tokens)  AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            COUNT(*)           AS request_count
          FROM token_usage
          WHERE workspace_id = ${workspaceId}
            AND created_at >= ${cutoff}
          GROUP BY agent_name, model
          ORDER BY agent_name, (SUM(input_tokens) + SUM(output_tokens)) DESC
        `) as any[])
      : ((await prisma.$queryRaw<any[]>`
          SELECT
            CASE
              WHEN INSTR(session_id, ':') > 0 THEN SUBSTR(session_id, 1, INSTR(session_id, ':') - 1)
              ELSE session_id
            END AS agent_name,
            model,
            SUM(input_tokens)  AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            COUNT(*)           AS request_count
          FROM token_usage
          WHERE workspace_id = ${workspaceId}
            AND created_at >= ${cutoff}
          GROUP BY agent_name, model
          ORDER BY agent_name, (SUM(input_tokens) + SUM(output_tokens)) DESC
        `) as any[])

    // Build model map keyed by agent name
    const modelsByAgent = new Map<string, ModelBreakdown[]>()
    for (const row of modelRows) {
      const input = Number((row as any).input_tokens ?? 0)
      const output = Number((row as any).output_tokens ?? 0)
      const cost = calculateTokenCost(String((row as any).model), input, output, { providerSubscriptions })
      const list = modelsByAgent.get(String((row as any).agent_name)) || []
      list.push({
        model: String((row as any).model),
        input_tokens: input,
        output_tokens: output,
        request_count: Number((row as any).request_count ?? 0),
        cost,
      })
      modelsByAgent.set(String((row as any).agent_name), list)
    }

    // Assemble final response
    const agents: AgentBreakdown[] = rows.map((row) => {
      const agentName = String((row as any).agent_name)
      const totalInput = Number((row as any).total_input_tokens ?? 0)
      const totalOutput = Number((row as any).total_output_tokens ?? 0)
      const models = modelsByAgent.get(agentName) || []
      const totalCost = models.reduce((sum, m) => sum + m.cost, 0)
      return {
        agent: agentName,
        total_input_tokens: totalInput,
        total_output_tokens: totalOutput,
        total_tokens: totalInput + totalOutput,
        total_cost: totalCost,
        session_count: Number((row as any).session_count ?? 0),
        request_count: Number((row as any).request_count ?? 0),
        last_active: new Date(Number((row as any).last_active ?? 0) * 1000).toISOString(),
        models,
      }
    })

    const totalCost = agents.reduce((sum, a) => sum + a.total_cost, 0)
    const totalTokens = agents.reduce((sum, a) => sum + a.total_tokens, 0)

    return NextResponse.json({
      agents,
      summary: {
        total_cost: totalCost,
        total_tokens: totalTokens,
        agent_count: agents.length,
        days,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tokens/by-agent error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
