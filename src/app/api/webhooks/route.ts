import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { randomBytes } from 'crypto'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { validateBody, createWebhookSchema } from '@/lib/validation'
import { getPrismaClient } from '@/lib/prisma'

const WEBHOOK_BLOCKED_HOSTNAMES = new Set([
  'localhost', '127.0.0.1', '::1', '0.0.0.0',
  'metadata.google.internal', 'metadata.internal', 'instance-data',
])

function isBlockedWebhookUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr)
    const hostname = url.hostname
    if (WEBHOOK_BLOCKED_HOSTNAMES.has(hostname)) return true
    if (hostname.endsWith('.local')) return true
    // Block private IPv4 ranges
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
      const parts = hostname.split('.').map(Number)
      if (parts[0] === 10) return true
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
      if (parts[0] === 192 && parts[1] === 168) return true
      if (parts[0] === 169 && parts[1] === 254) return true
      if (parts[0] === 127) return true
    }
    return false
  } catch {
    return true
  }
}

/**
 * GET /api/webhooks - List all webhooks with delivery stats
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    const webhooks = await prisma.$queryRaw<any[]>`
      SELECT w.*,
        (SELECT COUNT(*) FROM webhook_deliveries wd WHERE wd.webhook_id = w.id AND wd.workspace_id = w.workspace_id) as total_deliveries,
        (SELECT COUNT(*) FROM webhook_deliveries wd WHERE wd.webhook_id = w.id AND wd.workspace_id = w.workspace_id AND wd.status_code BETWEEN 200 AND 299) as successful_deliveries,
        (SELECT COUNT(*) FROM webhook_deliveries wd WHERE wd.webhook_id = w.id AND wd.workspace_id = w.workspace_id AND (wd.error IS NOT NULL OR wd.status_code NOT BETWEEN 200 AND 299)) as failed_deliveries
      FROM webhooks w
      WHERE w.workspace_id = ${workspaceId}
      ORDER BY w.created_at DESC
    `

    // Parse events JSON, mask secret, add circuit breaker status
    const maxRetries = parseInt(process.env.MC_WEBHOOK_MAX_RETRIES || '5', 10) || 5
    const result = webhooks.map((wh) => ({
      ...wh,
      events: JSON.parse(wh.events || '["*"]'),
      secret: wh.secret ? '••••••' + wh.secret.slice(-4) : null,
      enabled: !!wh.enabled,
      consecutive_failures: wh.consecutive_failures ?? 0,
      circuit_open: (wh.consecutive_failures ?? 0) >= maxRetries,
    }))

    return NextResponse.json({ webhooks: result })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/webhooks error')
    return NextResponse.json({ error: 'Failed to fetch webhooks' }, { status: 500 })
  }
}

/**
 * POST /api/webhooks - Create a new webhook
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    const validated = await validateBody(request, createWebhookSchema)
    if ('error' in validated) return validated.error
    const body = validated.data
    const { name, url, events, generate_secret } = body

    if (isBlockedWebhookUrl(url)) {
      return NextResponse.json({ error: 'Webhook URL cannot point to internal or private services' }, { status: 400 })
    }

    const secret = generate_secret !== false ? randomBytes(32).toString('hex') : null
    const eventsJson = JSON.stringify(events || ['*'])
    const now = Math.floor(Date.now() / 1000)

    const created = await prisma.webhooks.create({
      data: {
        name,
        url,
        secret,
        events: eventsJson,
        created_by: auth.user.username,
        workspace_id: workspaceId,
        created_at: now,
        updated_at: now,
      } as any,
      select: { id: true },
    })

    return NextResponse.json({
      id: created.id,
      name,
      url,
      secret, // Show full secret only on creation
      events: events || ['*'],
      enabled: true,
      message: 'Webhook created. Save the secret - it won\'t be shown again in full.',
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/webhooks error')
    return NextResponse.json({ error: 'Failed to create webhook' }, { status: 500 })
  }
}

/**
 * PUT /api/webhooks - Update a webhook
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { id, name, url, events, enabled, regenerate_secret, reset_circuit } = body

    if (!id) {
      return NextResponse.json({ error: 'Webhook ID is required' }, { status: 400 })
    }

    const existing = await prisma.webhooks.findFirst({
      where: { id: Number(id), workspace_id: workspaceId },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    if (url) {
      try { new URL(url) } catch {
        return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
      }
      if (isBlockedWebhookUrl(url)) {
        return NextResponse.json({ error: 'Webhook URL cannot point to internal or private services' }, { status: 400 })
      }
    }

    const now = Math.floor(Date.now() / 1000)
    const data: any = { updated_at: now }

    if (name !== undefined) data.name = name
    if (url !== undefined) data.url = url
    if (events !== undefined) data.events = JSON.stringify(events)
    if (enabled !== undefined) data.enabled = enabled ? 1 : 0

    // Reset circuit breaker: clear failure count and re-enable
    if (reset_circuit) {
      data.consecutive_failures = 0
      data.enabled = 1
    }

    let newSecret: string | null = null
    if (regenerate_secret) {
      newSecret = randomBytes(32).toString('hex')
      data.secret = newSecret
    }

    await prisma.webhooks.updateMany({
      where: { id: Number(id), workspace_id: workspaceId },
      data,
    })

    return NextResponse.json({
      success: true,
      ...(newSecret ? { secret: newSecret, message: 'New secret generated. Save it now.' } : {}),
    })
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/webhooks error')
    return NextResponse.json({ error: 'Failed to update webhook' }, { status: 500 })
  }
}

/**
 * DELETE /api/webhooks - Delete a webhook
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Request body required' }, { status: 400 }) }
    const id = body.id

    if (!id) {
      return NextResponse.json({ error: 'Webhook ID is required' }, { status: 400 })
    }

    const webhookId = Number(id)

    const [, result] = await prisma.$transaction([
      prisma.webhook_deliveries.deleteMany({ where: { webhook_id: webhookId, workspace_id: workspaceId } }),
      prisma.webhooks.deleteMany({ where: { id: webhookId, workspace_id: workspaceId } }),
    ])

    if (result.count === 0) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true, deleted: result.count })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/webhooks error')
    return NextResponse.json({ error: 'Failed to delete webhook' }, { status: 500 })
  }
}
