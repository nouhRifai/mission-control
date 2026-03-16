import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { deliverWebhookPublic } from '@/lib/webhooks'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'

/**
 * POST /api/webhooks/test - Send a test event to a webhook
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    const { id } = await request.json()

    if (!id) {
      return NextResponse.json({ error: 'Webhook ID is required' }, { status: 400 })
    }

    const webhook = await prisma.webhooks.findFirst({
      where: { id: Number(id), workspace_id: workspaceId },
    }) as any
    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    const payload = {
      message: 'This is a test webhook from Mission Control',
      webhook_id: webhook.id,
      webhook_name: webhook.name,
      triggered_by: auth.user.username,
    }

    const result = await deliverWebhookPublic(webhook, 'test.ping', payload, { allowRetry: false })

    return NextResponse.json(result)
  } catch (error) {
    logger.error({ err: error }, 'POST /api/webhooks/test error')
    return NextResponse.json({ error: 'Failed to test webhook' }, { status: 500 })
  }
}
