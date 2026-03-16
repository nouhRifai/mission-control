import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'

/**
 * GET /api/webhooks/deliveries - Get delivery history for a webhook
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    const { searchParams } = new URL(request.url)
    const webhookId = searchParams.get('webhook_id')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200)
    const offset = parseInt(searchParams.get('offset') || '0')

    const webhookIdInt = webhookId ? Number(webhookId) : null
    const deliveries = webhookIdInt
      ? await prisma.$queryRaw<any[]>`
          SELECT wd.*, w.name as webhook_name, w.url as webhook_url
          FROM webhook_deliveries wd
          JOIN webhooks w ON wd.webhook_id = w.id AND w.workspace_id = wd.workspace_id
          WHERE wd.workspace_id = ${workspaceId}
            AND wd.webhook_id = ${webhookIdInt}
          ORDER BY wd.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `
      : await prisma.$queryRaw<any[]>`
          SELECT wd.*, w.name as webhook_name, w.url as webhook_url
          FROM webhook_deliveries wd
          JOIN webhooks w ON wd.webhook_id = w.id AND w.workspace_id = wd.workspace_id
          WHERE wd.workspace_id = ${workspaceId}
          ORDER BY wd.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `

    const total = await prisma.webhook_deliveries.count({
      where: {
        workspace_id: workspaceId,
        ...(webhookIdInt ? { webhook_id: webhookIdInt } : {}),
      } as any,
    })

    return NextResponse.json({ deliveries, total })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/webhooks/deliveries error')
    return NextResponse.json({ error: 'Failed to fetch deliveries' }, { status: 500 })
  }
}
