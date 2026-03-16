import { NextRequest, NextResponse } from "next/server"
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'

type MessageRow = {
  id: number
  conversation_id: string
  from_agent: string
  to_agent: string | null
  content: string
  message_type: string | null
  metadata: string | null
  read_at: number | null
  created_at: number
  workspace_id: number
}

/**
 * GET /api/agents/comms - Inter-agent communication stats and timeline
 * Query params: limit, offset, since, agent
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const { searchParams } = new URL(request.url)
    const workspaceId = auth.user.workspace_id ?? 1

    const limit = parseInt(searchParams.get("limit") || "100")
    const offset = parseInt(searchParams.get("offset") || "0")
    const since = searchParams.get("since")
    const agent = searchParams.get("agent")

    // Session-thread comms feed used by coordinator + runtime sessions.
    // Previously used JSON-path queries on metadata; keep behavior provider-neutral by matching the serialized JSON.
    const commsPredicate = [
      { conversation_id: { startsWith: 'a2a:' } },
      { conversation_id: { startsWith: 'coord:' } },
      { conversation_id: { startsWith: 'session:' } },
      { conversation_id: { startsWith: 'agent_' } },
      { metadata: { contains: 'coordinator-inbox' } },
    ]

    const andFilters: any[] = [
      { workspace_id: workspaceId },
      { OR: commsPredicate },
    ]

    const sinceValue = since ? parseInt(since, 10) : null
    if (sinceValue != null && Number.isFinite(sinceValue)) {
      andFilters.push({ created_at: { gt: sinceValue } })
    }
    if (agent) {
      andFilters.push({ OR: [{ from_agent: agent }, { to_agent: agent }] })
    }

    const whereClause = { AND: andFilters }

    // 1. Timeline messages (page latest rows but render chronologically)
    const messagesDesc = (await prisma.messages.findMany({
      where: whereClause,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset,
    })) as unknown as MessageRow[]

    const messages = [...messagesDesc].sort((a, b) => (a.created_at - b.created_at) || (a.id - b.id))

    const humanNames = ["human", "system", "operator"]
    const humanNamesSql = humanNames.map((name) => `'${name}'`).join(',')

    const sinceSql = sinceValue != null && Number.isFinite(sinceValue) ? ` AND created_at > ${sinceValue}` : ''

    // 2. Communication graph edges
    const edges = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        from_agent, to_agent,
        COUNT(*) as message_count,
        MAX(created_at) as last_message_at
      FROM messages
      WHERE workspace_id = ${workspaceId}
        AND (
          conversation_id LIKE 'a2a:%'
          OR conversation_id LIKE 'coord:%'
          OR conversation_id LIKE 'session:%'
          OR conversation_id LIKE 'agent_%'
          OR (metadata IS NOT NULL AND metadata LIKE '%coordinator-inbox%')
        )
        AND to_agent IS NOT NULL
        AND lower(from_agent) NOT IN (${humanNamesSql})
        AND lower(to_agent) NOT IN (${humanNamesSql})
        ${sinceSql}
      GROUP BY from_agent, to_agent
      ORDER BY message_count DESC
    `)

    // 3. Per-agent sent/received stats
    const agentStats = await prisma.$queryRawUnsafe<any[]>(`
      SELECT agent, SUM(sent) as sent, SUM(received) as received FROM (
        SELECT from_agent as agent, COUNT(*) as sent, 0 as received
        FROM messages
        WHERE workspace_id = ${workspaceId}
          AND (
            conversation_id LIKE 'a2a:%'
            OR conversation_id LIKE 'coord:%'
            OR conversation_id LIKE 'session:%'
            OR conversation_id LIKE 'agent_%'
            OR (metadata IS NOT NULL AND metadata LIKE '%coordinator-inbox%')
          )
          AND to_agent IS NOT NULL
          AND lower(from_agent) NOT IN (${humanNamesSql})
          AND lower(to_agent) NOT IN (${humanNamesSql})
          ${sinceSql}
        GROUP BY from_agent
        UNION ALL
        SELECT to_agent as agent, 0 as sent, COUNT(*) as received
        FROM messages
        WHERE workspace_id = ${workspaceId}
          AND (
            conversation_id LIKE 'a2a:%'
            OR conversation_id LIKE 'coord:%'
            OR conversation_id LIKE 'session:%'
            OR conversation_id LIKE 'agent_%'
            OR (metadata IS NOT NULL AND metadata LIKE '%coordinator-inbox%')
          )
          AND to_agent IS NOT NULL
          AND lower(from_agent) NOT IN (${humanNamesSql})
          AND lower(to_agent) NOT IN (${humanNamesSql})
          ${sinceSql}
        GROUP BY to_agent
      ) GROUP BY agent
      ORDER BY (sent + received) DESC
    `)

    // 4. Total + seeded counts
    const total = await prisma.messages.count({ where: whereClause })

    const seededFilters: any[] = [
      { workspace_id: workspaceId },
      { OR: commsPredicate },
      { conversation_id: { startsWith: 'conv-multi-' } },
    ]
    if (sinceValue != null && Number.isFinite(sinceValue)) {
      seededFilters.push({ created_at: { gt: sinceValue } })
    }
    if (agent) {
      seededFilters.push({ OR: [{ from_agent: agent }, { to_agent: agent }] })
    }
    const seededCount = await prisma.messages.count({ where: { AND: seededFilters } })

    const liveCount = Math.max(0, total - seededCount)
    const source =
      total === 0 ? "empty" :
      liveCount === 0 ? "seeded" :
      seededCount === 0 ? "live" :
      "mixed"

    const parsed = messages.map((msg) => {
      let parsedMetadata: any = null
      if (msg.metadata) {
        try {
          parsedMetadata = JSON.parse(msg.metadata)
        } catch {
          parsedMetadata = null
        }
      }
      return {
        ...msg,
        metadata: parsedMetadata,
      }
    })

    return NextResponse.json({
      messages: parsed,
      total,
      graph: { edges, agentStats },
      source: { mode: source, seededCount, liveCount },
    })
  } catch (error) {
    logger.error({ err: error }, "GET /api/agents/comms error")
    return NextResponse.json({ error: "Failed to fetch agent communications" }, { status: 500 })
  }
}
