import { NextRequest, NextResponse } from 'next/server'
import { Message } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'

/**
 * GET /api/chat/messages/[id] - Get a single message
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const { id } = await params
    const workspaceId = auth.user.workspace_id ?? 1

    const message = await prisma.messages.findFirst({
      where: { id: parseInt(id), workspace_id: workspaceId },
    }) as unknown as Message | null

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    return NextResponse.json({
      message: {
        ...message,
        metadata: message.metadata ? JSON.parse(message.metadata) : null
      }
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/chat/messages/[id] error')
    return NextResponse.json({ error: 'Failed to fetch message' }, { status: 500 })
  }
}

/**
 * PATCH /api/chat/messages/[id] - Mark message as read
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const { id } = await params
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()

    const message = await prisma.messages.findFirst({
      where: { id: parseInt(id), workspace_id: workspaceId },
    }) as unknown as Message | null

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    if (body.read) {
      const now = Math.floor(Date.now() / 1000)
      await prisma.messages.updateMany({
        where: { id: parseInt(id), workspace_id: workspaceId },
        data: { read_at: now },
      })
    }

    const updated = await prisma.messages.findFirst({
      where: { id: parseInt(id), workspace_id: workspaceId },
    }) as unknown as Message | null
    if (!updated) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    return NextResponse.json({
      message: {
        ...updated,
        metadata: updated.metadata ? JSON.parse(updated.metadata) : null
      }
    })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/chat/messages/[id] error')
    return NextResponse.json({ error: 'Failed to update message' }, { status: 500 })
  }
}
