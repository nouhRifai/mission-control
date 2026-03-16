import { createHash, randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'

const ALLOWED_SCOPES = new Set([
  'viewer',
  'operator',
  'admin',
  'agent:self',
  'agent:diagnostics',
  'agent:attribution',
  'agent:heartbeat',
  'agent:messages',
])

interface AgentRow {
  id: number
  name: string
  workspace_id: number
}

interface AgentKeyRow {
  id: number
  name: string
  key_prefix: string
  scopes: string
  created_by: string | null
  expires_at: number | null
  revoked_at: number | null
  last_used_at: number | null
  created_at: number
  updated_at: number
}

function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

async function resolveAgent(idParam: string, workspaceId: number): Promise<AgentRow | null> {
  const prisma = getPrismaClient()
  if (/^\d+$/.test(idParam)) {
    return await prisma.agents.findFirst({
      where: { id: Number(idParam), workspace_id: workspaceId },
      select: { id: true, name: true, workspace_id: true },
    })
  }

  return await prisma.agents.findFirst({
    where: { name: idParam, workspace_id: workspaceId },
    select: { id: true, name: true, workspace_id: true },
  })
}

function parseScopes(rawScopes: unknown): string[] {
  const fallback = ['viewer', 'agent:self']
  if (!Array.isArray(rawScopes)) return fallback

  const scopes = rawScopes
    .map((scope) => String(scope).trim())
    .filter((scope) => scope.length > 0 && ALLOWED_SCOPES.has(scope))

  if (scopes.length === 0) return fallback
  return Array.from(new Set(scopes))
}

function parseExpiry(body: any): number | null {
  if (body?.expires_at != null) {
    const value = Number(body.expires_at)
    if (!Number.isInteger(value) || value <= 0) throw new Error('expires_at must be a future unix timestamp')
    return value
  }

  if (body?.expires_in_days != null) {
    const days = Number(body.expires_in_days)
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      throw new Error('expires_in_days must be between 1 and 3650')
    }
    return Math.floor(Date.now() / 1000) + Math.floor(days * 24 * 60 * 60)
  }

  return null
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const resolved = await params
    const workspaceId = auth.user.workspace_id ?? 1
    const agent = await resolveAgent(resolved.id, workspaceId)
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

    const rows = (await prisma.agent_api_keys.findMany({
      where: { agent_id: agent.id, workspace_id: workspaceId },
      select: {
        id: true,
        name: true,
        key_prefix: true,
        scopes: true,
        created_by: true,
        expires_at: true,
        revoked_at: true,
        last_used_at: true,
        created_at: true,
        updated_at: true,
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    })) as unknown as AgentKeyRow[]

    return NextResponse.json({
      agent: { id: agent.id, name: agent.name },
      keys: rows.map((row) => ({
        ...row,
        scopes: (() => {
          try {
            const parsed = JSON.parse(row.scopes)
            return Array.isArray(parsed) ? parsed : []
          } catch {
            return []
          }
        })(),
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/keys error')
    return NextResponse.json({ error: 'Failed to list agent API keys' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const resolved = await params
    const workspaceId = auth.user.workspace_id ?? 1
    const agent = await resolveAgent(resolved.id, workspaceId)
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

    const body = await request.json().catch(() => ({}))
    const name = String(body?.name || 'default').trim().slice(0, 128)
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

    let expiresAt: number | null = null
    try {
      expiresAt = parseExpiry(body)
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 })
    }

    const scopes = parseScopes(body?.scopes)
    const now = Math.floor(Date.now() / 1000)
    const rawKey = `mca_${randomBytes(24).toString('hex')}`
    const keyHash = hashApiKey(rawKey)
    const keyPrefix = rawKey.slice(0, 12)

    const created = await prisma.agent_api_keys.create({
      data: {
        agent_id: agent.id,
        workspace_id: workspaceId,
        name,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        scopes: JSON.stringify(scopes),
        expires_at: expiresAt,
        revoked_at: null,
        last_used_at: null,
        created_by: auth.user.username,
        created_at: now,
        updated_at: now,
      },
      select: { id: true },
    })

    return NextResponse.json(
      {
        key: {
          id: created.id,
          name,
          key_prefix: keyPrefix,
          scopes,
          expires_at: expiresAt,
          created_at: now,
        },
        api_key: rawKey,
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents/[id]/keys error')
    return NextResponse.json({ error: 'Failed to create agent API key' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const resolved = await params
    const workspaceId = auth.user.workspace_id ?? 1
    const agent = await resolveAgent(resolved.id, workspaceId)
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

    const body = await request.json().catch(() => ({}))
    const keyId = Number(body?.key_id)
    if (!Number.isInteger(keyId) || keyId <= 0) {
      return NextResponse.json({ error: 'key_id must be a positive integer' }, { status: 400 })
    }

    const now = Math.floor(Date.now() / 1000)
    const result = await prisma.agent_api_keys.updateMany({
      where: {
        id: keyId,
        agent_id: agent.id,
        workspace_id: workspaceId,
        revoked_at: null,
      },
      data: { revoked_at: now, updated_at: now },
    })

    if (result.count < 1) {
      return NextResponse.json({ error: 'Active key not found for this agent' }, { status: 404 })
    }

    return NextResponse.json({ success: true, key_id: keyId, revoked_at: now })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/agents/[id]/keys error')
    return NextResponse.json({ error: 'Failed to revoke agent API key' }, { status: 500 })
  }
}
