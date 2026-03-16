import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/auth'
import { logAuditEvent } from '@/lib/db'
import { getPrismaClient } from '@/lib/prisma'

export async function POST(request: Request) {
  const user = await getUserFromRequest(request)
  if (!user || user.id === 0) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  if (user.provider !== 'google') {
    return NextResponse.json({ error: 'Account is not connected to Google' }, { status: 400 })
  }

  const prisma = getPrismaClient()

  // Check that the user has a password set so they can still log in after disconnect
  const row = await prisma.users.findUnique({
    where: { id: user.id },
    select: { password_hash: true },
  })
  if (!row?.password_hash) {
    return NextResponse.json(
      { error: 'Cannot disconnect Google — no password set. Set a password first to avoid being locked out.' },
      { status: 400 }
    )
  }

  const now = Math.floor(Date.now() / 1000)
  await prisma.users.update({
    where: { id: user.id },
    data: { provider: 'local', provider_user_id: null, updated_at: now } as any,
    select: { id: true },
  })

  const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
  const userAgent = request.headers.get('user-agent') || undefined
  logAuditEvent({
    action: 'google_disconnect',
    actor: user.username,
    actor_id: user.id,
    ip_address: ipAddress,
    user_agent: userAgent,
  })

  return NextResponse.json({ ok: true })
}
