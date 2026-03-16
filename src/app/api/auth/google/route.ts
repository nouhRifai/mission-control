import { NextRequest, NextResponse } from 'next/server'
import { createSession } from '@/lib/auth'
import { logAuditEvent } from '@/lib/db'
import { verifyGoogleIdToken } from '@/lib/google-auth'
import { getMcSessionCookieName, getMcSessionCookieOptions, isRequestSecure } from '@/lib/session-cookie'
import { loginLimiter } from '@/lib/rate-limit'
import { getPrismaClient } from '@/lib/prisma'

async function upsertAccessRequest(input: {
  email: string
  providerUserId: string
  displayName: string
  avatarUrl?: string
}) {
  const prisma = getPrismaClient()
  const now = Math.floor(Date.now() / 1000)

  await prisma.access_requests.upsert({
    where: {
      email_provider: {
        email: input.email.toLowerCase(),
        provider: 'google',
      },
    },
    create: {
      provider: 'google',
      email: input.email.toLowerCase(),
      provider_user_id: input.providerUserId,
      display_name: input.displayName,
      avatar_url: input.avatarUrl || null,
      status: 'pending',
      attempt_count: 1,
      requested_at: now,
      last_attempt_at: now,
    } as any,
    update: {
      provider_user_id: input.providerUserId,
      display_name: input.displayName,
      avatar_url: input.avatarUrl || null,
      status: 'pending',
      attempt_count: { increment: 1 },
      last_attempt_at: now,
    } as any,
    select: { id: true },
  })
}

export async function POST(request: NextRequest) {
  const rateCheck = loginLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const body = await request.json().catch(() => ({}))
    const credential = String(body?.credential || '')
    const profile = await verifyGoogleIdToken(credential)

    const prisma = getPrismaClient()
    const email = String(profile.email || '').toLowerCase().trim()
    const sub = String(profile.sub || '').trim()
    const displayName = String(profile.name || email.split('@')[0] || 'Google User').trim()
    const avatar = profile.picture ? String(profile.picture) : null

    const row = (
      await prisma.$queryRaw<any[]>`
        SELECT u.id, u.username, u.display_name, u.role, u.provider, u.email, u.avatar_url, u.is_approved,
               u.created_at, u.updated_at, u.last_login_at, u.workspace_id, COALESCE(w.tenant_id, 1) as tenant_id
        FROM users u
        LEFT JOIN workspaces w ON w.id = u.workspace_id
        WHERE (provider = 'google' AND provider_user_id = ${sub}) OR lower(email) = ${email}
        ORDER BY id ASC
        LIMIT 1
      `
    )[0] as any

    const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
    const userAgent = request.headers.get('user-agent') || undefined

    if (!row || Number(row.is_approved ?? 1) !== 1) {
      await upsertAccessRequest({
        email,
        providerUserId: sub,
        displayName,
        avatarUrl: avatar || undefined,
      })

      logAuditEvent({
        action: 'google_login_pending_approval',
        actor: email,
        detail: { email, sub },
        ip_address: ipAddress,
        user_agent: userAgent,
      })

      return NextResponse.json(
        { error: 'Access request pending admin approval', code: 'PENDING_APPROVAL' },
        { status: 403 }
      )
    }

    const now = Math.floor(Date.now() / 1000)
    await prisma.users.update({
      where: { id: row.id },
      data: {
        provider: 'google',
        provider_user_id: sub,
        email,
        ...(avatar ? { avatar_url: avatar } : {}),
        updated_at: now,
      } as any,
      select: { id: true },
    })

    const { token, expiresAt } = await createSession(row.id, ipAddress, userAgent, row.workspace_id ?? 1)

    logAuditEvent({ action: 'login_google', actor: row.username, actor_id: row.id, ip_address: ipAddress, user_agent: userAgent })

    const response = NextResponse.json({
      user: {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        role: row.role,
        provider: 'google',
        email,
        avatar_url: avatar,
        workspace_id: row.workspace_id ?? 1,
        tenant_id: row.tenant_id ?? 1,
      },
    })

    const isSecureRequest = isRequestSecure(request)
    const cookieName = getMcSessionCookieName(isSecureRequest)

    response.cookies.set(cookieName, token, {
      ...getMcSessionCookieOptions({ maxAgeSeconds: expiresAt - Math.floor(Date.now() / 1000), isSecureRequest }),
    })

    return response
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Google login failed' }, { status: 400 })
  }
}
