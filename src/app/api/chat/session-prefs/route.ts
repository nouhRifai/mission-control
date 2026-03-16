import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'

const PREFS_KEY = 'chat.session_prefs.v1'
const ALLOWED_COLORS = new Set(['slate', 'blue', 'green', 'amber', 'red', 'purple', 'pink', 'teal'])

type SessionPref = {
  name?: string
  color?: string
}

type SessionPrefs = Record<string, SessionPref>

async function loadPrefs(): Promise<SessionPrefs> {
  const prisma = getPrismaClient()
  const row = await prisma.settings.findUnique({
    where: { key: PREFS_KEY },
    select: { value: true },
  })
  if (!row?.value) return {}
  try {
    const parsed = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function savePrefs(prefs: SessionPrefs, username: string) {
  const prisma = getPrismaClient()
  const now = Math.floor(Date.now() / 1000)
  await prisma.settings.upsert({
    where: { key: PREFS_KEY },
    create: {
      key: PREFS_KEY,
      value: JSON.stringify(prefs),
      description: 'Chat local session preferences (rename + color tags)',
      category: 'chat',
      updated_by: username,
      updated_at: now,
    } as any,
    update: {
      value: JSON.stringify(prefs),
      updated_by: username,
      updated_at: now,
    } as any,
    select: { key: true },
  })
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    return NextResponse.json({ prefs: await loadPrefs() })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/chat/session-prefs error')
    return NextResponse.json({ error: 'Failed to load preferences' }, { status: 500 })
  }
}

/**
 * PATCH /api/chat/session-prefs
 * Body: { key: "claude-code:<sessionId>", name?: string, color?: string | null }
 */
export async function PATCH(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const body = await request.json().catch(() => ({}))
    const key = typeof body?.key === 'string' ? body.key.trim() : ''
    if (!key || !/^[a-zA-Z0-9_-]+:[a-zA-Z0-9._:-]+$/.test(key)) {
      return NextResponse.json({ error: 'Invalid key' }, { status: 400 })
    }

    const nextName = body?.name === null ? '' : (typeof body?.name === 'string' ? body.name.trim() : undefined)
    const nextColor = body?.color === null ? '' : (typeof body?.color === 'string' ? body.color.trim().toLowerCase() : undefined)

    if (typeof nextName === 'string' && nextName.length > 80) {
      return NextResponse.json({ error: 'name must be <= 80 chars' }, { status: 400 })
    }
    if (typeof nextColor === 'string' && nextColor && !ALLOWED_COLORS.has(nextColor)) {
      return NextResponse.json({ error: 'Invalid color' }, { status: 400 })
    }

    const prefs = await loadPrefs()
    const existing = prefs[key] || {}
    const updated: SessionPref = {
      ...existing,
      ...(typeof nextName === 'string' ? { name: nextName || undefined } : {}),
      ...(typeof nextColor === 'string' ? { color: nextColor || undefined } : {}),
    }

    if (!updated.name && !updated.color) {
      delete prefs[key]
    } else {
      prefs[key] = updated
    }

    await savePrefs(prefs, auth.user.username)

    return NextResponse.json({ ok: true, pref: prefs[key] || null })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/chat/session-prefs error')
    return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
