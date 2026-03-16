import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/db'
import { getDetectedGatewayPort, getDetectedGatewayToken } from '@/lib/gateway-runtime'
import { getPrismaClient } from '@/lib/prisma'

interface GatewayEntry {
  id: number
  name: string
  host: string
  port: number
  token: string
  is_primary: number
  status: string
  last_seen: number | null
  latency: number | null
  sessions_count: number
  agents_count: number
  created_at: number
  updated_at: number
}

/**
 * GET /api/gateways - List all registered gateways
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const prisma = getPrismaClient()
  const gateways = (await prisma.gateways.findMany({
    orderBy: [{ is_primary: 'desc' }, { name: 'asc' }],
  })) as unknown as GatewayEntry[]

  // If no gateways exist, seed defaults from environment
  if (gateways.length === 0) {
    const name = String(process.env.MC_DEFAULT_GATEWAY_NAME || 'primary')
    const host = String(process.env.OPENCLAW_GATEWAY_HOST || '127.0.0.1')
    const mainPort = getDetectedGatewayPort() || parseInt(process.env.NEXT_PUBLIC_GATEWAY_PORT || '18789')
    const mainToken = getDetectedGatewayToken()

    const now = Math.floor(Date.now() / 1000)
    try {
      await prisma.gateways.create({
        data: { name, host, port: mainPort, token: mainToken, is_primary: 1, created_at: now, updated_at: now } as any,
      })
    } catch {
      // Best effort: if the unique name already exists due to a race, continue to listing.
    }

    const seeded = (await prisma.gateways.findMany({
      orderBy: [{ is_primary: 'desc' }, { name: 'asc' }],
    })) as unknown as GatewayEntry[]
    return NextResponse.json({ gateways: redactTokens(seeded) })
  }

  return NextResponse.json({ gateways: redactTokens(gateways) })
}

/**
 * POST /api/gateways - Add a new gateway
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const prisma = getPrismaClient()
  const body = await request.json()

  const { name, host, port, token, is_primary } = body

  if (!name || !host || !port) {
    return NextResponse.json({ error: 'name, host, and port are required' }, { status: 400 })
  }

  try {
    const now = Math.floor(Date.now() / 1000)
    const created = await prisma.$transaction(async (tx) => {
      if (is_primary) {
        await tx.gateways.updateMany({ data: { is_primary: 0, updated_at: now } as any })
      }
      return tx.gateways.create({
        data: {
          name,
          host,
          port: Number(port),
          token: token || '',
          is_primary: is_primary ? 1 : 0,
          created_at: now,
          updated_at: now,
        } as any,
      })
    })

    logAuditEvent({
      action: 'gateway_added',
      actor: auth.user?.username || 'system',
      detail: `Added gateway: ${name} (${host}:${port})`,
      actor_id: auth.user?.id,
    })

    return NextResponse.json({ gateway: redactToken(created as any) }, { status: 201 })
  } catch (err: any) {
    if (err.message?.includes('UNIQUE')) {
      return NextResponse.json({ error: 'A gateway with that name already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: err.message || 'Failed to add gateway' }, { status: 500 })
  }
}

/**
 * PUT /api/gateways - Update a gateway
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const prisma = getPrismaClient()
  const body = await request.json()
  const { id, ...updates } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const existing = await prisma.gateways.findFirst({ where: { id: Number(id) } })
  if (!existing) return NextResponse.json({ error: 'Gateway not found' }, { status: 404 })

  const allowed = ['name', 'host', 'port', 'token', 'is_primary', 'status', 'last_seen', 'latency', 'sessions_count', 'agents_count']
  const data: any = {}

  for (const key of allowed) {
    if (key in updates) {
      data[key] = updates[key]
    }
  }

  if (Object.keys(data).length === 0) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })

  const now = Math.floor(Date.now() / 1000)
  data.updated_at = now

  const updated = await prisma.$transaction(async (tx) => {
    if (data.is_primary) {
      await tx.gateways.updateMany({ data: { is_primary: 0, updated_at: now } as any })
    }
    await tx.gateways.updateMany({ where: { id: Number(id) }, data })
    return tx.gateways.findFirst({ where: { id: Number(id) } })
  })
  if (!updated) return NextResponse.json({ error: 'Gateway not found' }, { status: 404 })

  return NextResponse.json({ gateway: redactToken(updated as any) })
}

/**
 * DELETE /api/gateways - Remove a gateway
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const prisma = getPrismaClient()
  const body = await request.json()
  const { id } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const gw = await prisma.gateways.findFirst({ where: { id: Number(id) } }) as any
  if (gw?.is_primary) {
    return NextResponse.json({ error: 'Cannot delete the primary gateway' }, { status: 400 })
  }

  const result = await prisma.gateways.deleteMany({ where: { id: Number(id) } })

  logAuditEvent({
    action: 'gateway_removed',
    actor: auth.user?.username || 'system',
    detail: `Removed gateway: ${gw?.name || id}`,
    actor_id: auth.user?.id,
  })

  return NextResponse.json({ deleted: result.count > 0 })
}

function redactToken(gw: GatewayEntry): GatewayEntry & { token_set: boolean } {
  return { ...gw, token: gw.token ? '--------' : '', token_set: !!gw.token }
}

function redactTokens(gws: GatewayEntry[]) {
  return gws.map(redactToken)
}
