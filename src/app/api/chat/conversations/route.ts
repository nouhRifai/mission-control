import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/sqlite'

/**
 * GET /api/chat/conversations - List conversations derived from messages
 * Query params: agent (filter by participant), limit, offset
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const { searchParams } = new URL(request.url)
    const workspaceId = auth.user.workspace_id ?? 1

    const agent = searchParams.get('agent')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200)
    const offset = parseInt(searchParams.get('offset') || '0')

    const conversations = agent
      ? await prisma.$queryRaw<any[]>`
          SELECT
            m.conversation_id,
            MAX(m.created_at) as last_message_at,
            COUNT(*) as message_count,
            COUNT(DISTINCT m.from_agent) + COUNT(DISTINCT CASE WHEN m.to_agent IS NOT NULL THEN m.to_agent END) as participant_count,
            SUM(CASE WHEN m.to_agent = ${agent} AND m.read_at IS NULL THEN 1 ELSE 0 END) as unread_count
          FROM messages m
          WHERE m.workspace_id = ${workspaceId} AND (m.from_agent = ${agent} OR m.to_agent = ${agent} OR m.to_agent IS NULL)
          GROUP BY m.conversation_id
          ORDER BY last_message_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `
      : await prisma.$queryRaw<any[]>`
          SELECT
            m.conversation_id,
            MAX(m.created_at) as last_message_at,
            COUNT(*) as message_count,
            COUNT(DISTINCT m.from_agent) + COUNT(DISTINCT CASE WHEN m.to_agent IS NOT NULL THEN m.to_agent END) as participant_count,
            0 as unread_count
          FROM messages m
          WHERE m.workspace_id = ${workspaceId}
          GROUP BY m.conversation_id
          ORDER BY last_message_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `

    const conversationIds = conversations.map((c) => String(c.conversation_id)).filter(Boolean)

    const lastMessages = conversationIds.length
      ? await prisma.$queryRaw<any[]>`
          SELECT *
          FROM (
            SELECT
              m.*,
              ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.created_at DESC) as rn
            FROM messages m
            WHERE m.workspace_id = ${workspaceId}
              AND m.conversation_id IN (${Prisma.join(conversationIds)})
          ) t
          WHERE t.rn = 1
        `
      : []
    const lastByConversation = new Map(lastMessages.map((m) => [String(m.conversation_id), m]))

    const withLastMessage = conversations.map((conv) => {
      const lastMsg = lastByConversation.get(String(conv.conversation_id)) as any
      return {
        ...conv,
        last_message: lastMsg
          ? { ...lastMsg, metadata: lastMsg.metadata ? JSON.parse(lastMsg.metadata) : null }
          : null,
      }
    })

    const total = agent
      ? (
          await prisma.$queryRaw<any[]>`
            SELECT COUNT(DISTINCT m.conversation_id) as total
            FROM messages m
            WHERE m.workspace_id = ${workspaceId} AND (m.from_agent = ${agent} OR m.to_agent = ${agent} OR m.to_agent IS NULL)
          `
        )[0]?.total ?? 0
      : (
          await prisma.$queryRaw<any[]>`
            SELECT COUNT(DISTINCT conversation_id) as total
            FROM messages
            WHERE workspace_id = ${workspaceId}
          `
        )[0]?.total ?? 0

    return NextResponse.json({
      conversations: withLastMessage,
      total,
      page: Math.floor(offset / limit) + 1,
      limit,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/chat/conversations error')
    return NextResponse.json({ error: 'Failed to fetch conversations' }, { status: 500 })
  }
}
