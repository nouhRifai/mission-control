import { createHmac, timingSafeEqual } from 'crypto'
import { eventBus, type ServerEvent } from './event-bus'
import { logger } from './logger'
import { getPrismaClient } from './prisma'

interface Webhook {
  id: number
  name: string
  url: string
  secret: string | null
  events: string // JSON array
  enabled: number
  workspace_id?: number
  consecutive_failures?: number
}

interface DeliverOpts {
  attempt?: number
  parentDeliveryId?: number | null
  allowRetry?: boolean
}

interface DeliveryResult {
  success: boolean
  status_code: number | null
  response_body: string | null
  error: string | null
  duration_ms: number
  delivery_id?: number
}

// Backoff schedule in seconds: 30s, 5m, 30m, 2h, 8h
const BACKOFF_SECONDS = [30, 300, 1800, 7200, 28800]

const MAX_RETRIES = parseInt(process.env.MC_WEBHOOK_MAX_RETRIES || '5', 10) || 5

// Map event bus events to webhook event types
const EVENT_MAP: Record<string, string> = {
  'activity.created': 'activity',         // Dynamically becomes activity.<type>
  'notification.created': 'notification',  // Dynamically becomes notification.<type>
  'agent.status_changed': 'agent.status_change',
  'audit.security': 'security',           // Dynamically becomes security.<action>
  'task.created': 'activity.task_created',
  'task.updated': 'activity.task_updated',
  'task.deleted': 'activity.task_deleted',
  'task.status_changed': 'activity.task_status_changed',
}

/**
 * Compute the next retry delay in seconds, with ±20% jitter.
 */
export function nextRetryDelay(attempt: number): number {
  const base = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)]
  const jitter = base * 0.2 * (2 * Math.random() - 1) // ±20%
  return Math.round(base + jitter)
}

/**
 * Verify a webhook signature using constant-time comparison.
 * Consumers can use this to validate incoming webhook deliveries.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null | undefined
): boolean {
  if (!signatureHeader || !secret) return false

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`

  // Constant-time comparison
  const sigBuf = Buffer.from(signatureHeader)
  const expectedBuf = Buffer.from(expected)

  if (sigBuf.length !== expectedBuf.length) {
    // Compare expected against a dummy buffer of matching length to avoid timing leak
    const dummy = Buffer.alloc(expectedBuf.length)
    timingSafeEqual(expectedBuf, dummy)
    return false
  }

  return timingSafeEqual(sigBuf, expectedBuf)
}

/**
 * Subscribe to the event bus and fire webhooks for matching events.
 * Called once during server initialization.
 */
export function initWebhookListener() {
  eventBus.on('server-event', (event: ServerEvent) => {
    const mapping = EVENT_MAP[event.type]
    if (!mapping) return

    // Build the specific webhook event type
    let webhookEventType: string
    if (mapping === 'activity' && event.data?.type) {
      webhookEventType = `activity.${event.data.type}`
    } else if (mapping === 'notification' && event.data?.type) {
      webhookEventType = `notification.${event.data.type}`
    } else if (mapping === 'security' && event.data?.action) {
      webhookEventType = `security.${event.data.action}`
    } else {
      webhookEventType = mapping
    }

    // Also fire agent.error for error status specifically
    const isAgentError = event.type === 'agent.status_changed' && event.data?.status === 'error'
    const workspaceId = typeof event.data?.workspace_id === 'number' ? event.data.workspace_id : 1

    fireWebhooksAsync(webhookEventType, event.data, workspaceId).catch((err) => {
      logger.error({ err }, 'Webhook dispatch error')
    })

    if (isAgentError) {
      fireWebhooksAsync('agent.error', event.data, workspaceId).catch((err) => {
        logger.error({ err }, 'Webhook dispatch error')
      })
    }
  })
}

/**
 * Fire all matching webhooks for an event type (public for test endpoint).
 */
export function fireWebhooks(eventType: string, payload: Record<string, any>, workspaceId?: number) {
  fireWebhooksAsync(eventType, payload, workspaceId).catch((err) => {
    logger.error({ err }, 'Webhook dispatch error')
  })
}

async function fireWebhooksAsync(eventType: string, payload: Record<string, any>, workspaceId?: number) {
  const resolvedWorkspaceId =
    workspaceId ?? (typeof payload?.workspace_id === 'number' ? payload.workspace_id : 1)
  let webhooks: Webhook[]
  try {
    const prisma = getPrismaClient()
    webhooks = (await prisma.webhooks.findMany({
      where: { enabled: 1, workspace_id: resolvedWorkspaceId },
      select: {
        id: true,
        name: true,
        url: true,
        secret: true,
        events: true,
        enabled: true,
        workspace_id: true,
        consecutive_failures: true,
      },
    })) as unknown as Webhook[]
  } catch {
    return // DB not ready or table doesn't exist yet
  }

  if (webhooks.length === 0) return

  const matchingWebhooks = webhooks.filter((wh) => {
    try {
      const events: string[] = JSON.parse(wh.events)
      return events.includes('*') || events.includes(eventType)
    } catch {
      return false
    }
  })

  await Promise.allSettled(
    matchingWebhooks.map((wh) => deliverWebhook(wh, eventType, payload, { allowRetry: true }))
  )
}

/**
 * Public wrapper for API routes (test endpoint, manual retry).
 * Returns delivery result fields for the response.
 */
export async function deliverWebhookPublic(
  webhook: Webhook,
  eventType: string,
  payload: Record<string, any>,
  opts?: DeliverOpts
): Promise<DeliveryResult> {
  return deliverWebhook(webhook, eventType, payload, opts ?? { allowRetry: false })
}

async function deliverWebhook(
  webhook: Webhook,
  eventType: string,
  payload: Record<string, any>,
  opts: DeliverOpts = {}
): Promise<DeliveryResult> {
  const { attempt = 0, parentDeliveryId = null, allowRetry = true } = opts

  const body = JSON.stringify({
    event: eventType,
    timestamp: Math.floor(Date.now() / 1000),
    data: payload,
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'MissionControl-Webhook/1.0',
    'X-MC-Event': eventType,
  }

  // HMAC signature if secret is configured
  if (webhook.secret) {
    const sig = createHmac('sha256', webhook.secret).update(body).digest('hex')
    headers['X-MC-Signature'] = `sha256=${sig}`
  }

  const start = Date.now()
  let statusCode: number | null = null
  let responseBody: string | null = null
  let error: string | null = null

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    const res = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })

    clearTimeout(timeout)
    statusCode = res.status
    responseBody = await res.text().catch(() => null)
    if (responseBody && responseBody.length > 1000) {
      responseBody = responseBody.slice(0, 1000) + '...'
    }
  } catch (err: any) {
    error = err.name === 'AbortError' ? 'Timeout (10s)' : err.message
  }

  const durationMs = Date.now() - start
  const success = statusCode !== null && statusCode >= 200 && statusCode < 300
  let deliveryId: number | undefined

  // Log delivery attempt and handle retry/circuit-breaker logic
  try {
    const prisma = getPrismaClient()
    const now = Math.floor(Date.now() / 1000)
    const resolvedWorkspaceId = webhook.workspace_id ?? 1

    const created = await prisma.webhook_deliveries.create({
      data: {
        webhook_id: webhook.id,
        event_type: eventType,
        payload: body,
        status_code: statusCode,
        response_body: responseBody,
        error,
        duration_ms: durationMs,
        attempt,
        is_retry: attempt > 0 ? 1 : 0,
        parent_delivery_id: parentDeliveryId,
        workspace_id: resolvedWorkspaceId,
        created_at: now,
      } as any,
      select: { id: true },
    })
    deliveryId = created.id

    await prisma.webhooks.updateMany({
      where: { id: webhook.id, workspace_id: resolvedWorkspaceId },
      data: { last_fired_at: now, last_status: statusCode ?? -1, updated_at: now },
    })

    // Circuit breaker + retry scheduling (skip for test deliveries)
    if (allowRetry) {
      if (success) {
        // Reset consecutive failures on success
        await prisma.webhooks.updateMany({
          where: { id: webhook.id, workspace_id: resolvedWorkspaceId },
          data: { consecutive_failures: 0 },
        })
      } else {
        // Increment consecutive failures
        await prisma.webhooks.updateMany({
          where: { id: webhook.id, workspace_id: resolvedWorkspaceId },
          data: { consecutive_failures: { increment: 1 } } as any,
        })

        if (attempt < MAX_RETRIES - 1) {
          // Schedule retry
          const delaySec = nextRetryDelay(attempt)
          const nextRetryAt = Math.floor(Date.now() / 1000) + delaySec
          await prisma.webhook_deliveries.updateMany({
            where: { id: deliveryId, workspace_id: resolvedWorkspaceId },
            data: { next_retry_at: nextRetryAt },
          })
        } else {
          // Exhausted retries — trip circuit breaker
          const wh = await prisma.webhooks.findFirst({
            where: { id: webhook.id, workspace_id: resolvedWorkspaceId },
            select: { consecutive_failures: true },
          })
          if (wh && (wh.consecutive_failures ?? 0) >= MAX_RETRIES) {
            await prisma.webhooks.updateMany({
              where: { id: webhook.id, workspace_id: resolvedWorkspaceId },
              data: { enabled: 0, updated_at: now },
            })
            logger.warn({ webhookId: webhook.id, name: webhook.name }, 'Webhook circuit breaker tripped — disabled after exhausting retries')
          }
        }
      }
    }

    // Prune old deliveries (keep last 200 per webhook)
    const keep = await prisma.webhook_deliveries.findMany({
      where: { webhook_id: webhook.id, workspace_id: resolvedWorkspaceId },
      orderBy: { created_at: 'desc' },
      take: 200,
      select: { id: true },
    })
    const keepIds = keep.map((row) => row.id)
    if (keepIds.length > 0) {
      await prisma.webhook_deliveries.deleteMany({
        where: { webhook_id: webhook.id, workspace_id: resolvedWorkspaceId, id: { notIn: keepIds } },
      })
    }
  } catch (logErr) {
    logger.error({ err: logErr, webhookId: webhook.id }, 'Webhook delivery logging/pruning failed')
  }

  return { success, status_code: statusCode, response_body: responseBody, error, duration_ms: durationMs, delivery_id: deliveryId }
}

/**
 * Process pending webhook retries. Called by the scheduler.
 * Picks up deliveries where next_retry_at has passed and re-delivers them.
 */
export async function processWebhookRetries(): Promise<{ ok: boolean; message: string }> {
  try {
    const prisma = getPrismaClient()
    const now = Math.floor(Date.now() / 1000)

    const pendingRetries = await prisma.webhook_deliveries.findMany({
      where: { next_retry_at: { not: null, lte: now } } as any,
      take: 50,
      include: {
        webhooks: {
          select: {
            id: true,
            name: true,
            url: true,
            secret: true,
            events: true,
            enabled: true,
            consecutive_failures: true,
            workspace_id: true,
          },
        },
      },
    })

    const eligible = pendingRetries.filter((row) => row.webhooks && (row.webhooks as any).enabled === 1)

    if (eligible.length === 0) {
      return { ok: true, message: 'No pending retries' }
    }

    // Clear next_retry_at immediately to prevent double-processing
    await prisma.webhook_deliveries.updateMany({
      where: { id: { in: eligible.map((row) => row.id) } },
      data: { next_retry_at: null },
    })

    // Re-deliver each
    let succeeded = 0
    let failed = 0
    for (const row of eligible) {
      const wh = row.webhooks as any
      const webhook: Webhook = {
        id: wh.id,
        name: wh.name,
        url: wh.url,
        secret: wh.secret,
        events: wh.events,
        enabled: wh.enabled,
        consecutive_failures: wh.consecutive_failures,
        workspace_id: row.workspace_id,
      }

      // Parse the original payload from the stored JSON body
      let parsedPayload: Record<string, any>
      try {
        const parsed = JSON.parse(row.payload as any)
        parsedPayload = parsed.data ?? parsed
      } catch {
        parsedPayload = {}
      }

      const result = await deliverWebhook(webhook, row.event_type, parsedPayload, {
        attempt: row.attempt + 1,
        parentDeliveryId: row.id,
        allowRetry: true,
      })

      if (result.success) succeeded++
      else failed++
    }

    return { ok: true, message: `Processed ${eligible.length} retries (${succeeded} ok, ${failed} failed)` }
  } catch (err: any) {
    return { ok: false, message: `Webhook retry failed: ${err.message}` }
  }
}
