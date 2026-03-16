import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { deliverWebhookPublic } from '@/lib/webhooks'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'

/**
 * POST /api/webhooks/retry - Manually retry a failed delivery
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    const { delivery_id } = await request.json()

    if (!delivery_id) {
      return NextResponse.json({ error: 'delivery_id is required' }, { status: 400 })
    }

    const delivery = await prisma.webhook_deliveries.findFirst({
      where: { id: Number(delivery_id), workspace_id: workspaceId },
      include: { webhooks: true },
    })

    if (!delivery || !delivery.webhooks) {
      return NextResponse.json({ error: 'Delivery not found' }, { status: 404 })
    }

    const webhook = {
      id: delivery.webhooks.id,
      name: delivery.webhooks.name,
      url: delivery.webhooks.url,
      secret: delivery.webhooks.secret,
      events: delivery.webhooks.events,
      enabled: delivery.webhooks.enabled,
      workspace_id: delivery.webhooks.workspace_id,
    }

    // Parse the original payload
    let parsedPayload: Record<string, any>
    try {
      const parsed = JSON.parse(delivery.payload as any)
      parsedPayload = parsed.data ?? parsed
    } catch {
      parsedPayload = {}
    }

    const result = await deliverWebhookPublic(webhook, delivery.event_type, parsedPayload, {
      attempt: (delivery.attempt ?? 0) + 1,
      parentDeliveryId: delivery.id as any,
      allowRetry: false, // Manual retries don't auto-schedule further retries
    })

    return NextResponse.json(result)
  } catch (error) {
    logger.error({ err: error }, 'POST /api/webhooks/retry error')
    return NextResponse.json({ error: 'Failed to retry delivery' }, { status: 500 })
  }
}
