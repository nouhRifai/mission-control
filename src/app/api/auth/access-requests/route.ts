import { randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getUserFromRequest , requireRole } from '@/lib/auth'
import { hashPassword } from '@/lib/password'
import { getPrismaClient } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/sqlite'
import { validateBody, accessRequestActionSchema } from '@/lib/validation'
import { mutationLimiter } from '@/lib/rate-limit'

function makeUsernameFromEmail(email: string): string {
  const base = email.split('@')[0].replace(/[^a-z0-9._-]/gi, '').toLowerCase() || 'user'
  return base.slice(0, 28)
}

type UsernameClient = {
  users: {
    findUnique: (args: { where: { username: string }; select: { id: true } }) => Promise<{ id: number } | null>
  }
}

async function ensureUniqueUsername(client: UsernameClient, base: string): Promise<string> {
  let candidate = base
  let i = 0
  while (await client.users.findUnique({ where: { username: candidate }, select: { id: true } })) {
    i += 1
    candidate = `${base.slice(0, 24)}-${i}`
  }
  return candidate
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  if (auth.user.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const prisma = getPrismaClient()

  const status = String(request.nextUrl.searchParams.get('status') || 'all')

  const rows = status === 'all'
    ? [
      ...(await prisma.access_requests.findMany({
        where: { status: 'pending' },
        orderBy: [{ last_attempt_at: 'desc' }, { id: 'desc' }],
      })),
      ...(await prisma.access_requests.findMany({
        where: { status: { not: 'pending' } },
        orderBy: [{ last_attempt_at: 'desc' }, { id: 'desc' }],
      })),
    ]
    : await prisma.access_requests.findMany({
      where: { status },
      orderBy: [{ last_attempt_at: 'desc' }, { id: 'desc' }],
    })

  return NextResponse.json({ requests: rows })
}

export async function POST(request: NextRequest) {
  const admin = await getUserFromRequest(request)
  if (!admin || admin.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const result = await validateBody(request, accessRequestActionSchema)
  if ('error' in result) return result.error

  const { request_id: requestId, action, role, note } = result.data

  const prisma = getPrismaClient()
  const reqRow = await prisma.access_requests.findUnique({ where: { id: requestId } })
  if (!reqRow) return NextResponse.json({ error: 'Request not found' }, { status: 404 })

  if (action === 'reject') {
    const now = Math.floor(Date.now() / 1000)
    await prisma.access_requests.update({
      where: { id: requestId },
      data: {
        status: 'rejected',
        reviewed_by: admin.username,
        reviewed_at: now,
        review_note: note ?? null,
      },
    })

    await prisma.audit_log.create({
      data: {
        action: 'access_request_rejected',
        actor: admin.username,
        actor_id: admin.id,
        detail: JSON.stringify({ request_id: requestId, email: reqRow.email, note }),
        created_at: now,
      },
    })

    return NextResponse.json({ ok: true })
  }

  const email = String(reqRow.email || '').toLowerCase()
  const providerUserId = reqRow.provider_user_id ? String(reqRow.provider_user_id) : null
  const displayName = String(reqRow.display_name || email.split('@')[0] || 'Google User')
  const avatarUrl = reqRow.avatar_url ? String(reqRow.avatar_url) : null

  const now = Math.floor(Date.now() / 1000)
  const user = await prisma.$transaction(async (tx) => {
    const providerMatch = providerUserId
      ? await tx.users.findFirst({
        where: { provider: 'google', provider_user_id: providerUserId },
        orderBy: { id: 'asc' },
        select: { id: true },
      })
      : null

    const emailMatch = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
      SELECT id
      FROM users
      WHERE email IS NOT NULL AND lower(email) = lower(${email})
      ORDER BY id ASC
      LIMIT 1
    `)

    const existingId = Math.min(
      providerMatch?.id ?? Number.POSITIVE_INFINITY,
      emailMatch[0]?.id ?? Number.POSITIVE_INFINITY,
    )

    let userId: number
    if (Number.isFinite(existingId)) {
      const data: any = {
        provider: 'google',
        provider_user_id: providerUserId,
        email,
        is_approved: 1,
        role,
        approved_by: admin.username,
        approved_at: now,
        updated_at: now,
      }
      if (avatarUrl) data.avatar_url = avatarUrl

      await tx.users.update({
        where: { id: existingId },
        data,
        select: { id: true },
      })
      userId = existingId
    } else {
      const username = await ensureUniqueUsername(tx as unknown as UsernameClient, makeUsernameFromEmail(email))
      const randomPwd = randomBytes(24).toString('hex')
      const passwordHash = hashPassword(randomPwd)

      const created = await tx.users.create({
        data: {
          username,
          display_name: displayName,
          password_hash: passwordHash,
          role,
          provider: 'google',
          provider_user_id: providerUserId,
          email,
          avatar_url: avatarUrl,
          is_approved: 1,
          approved_by: admin.username,
          approved_at: now,
          workspace_id: admin.workspace_id || 1,
          created_at: now,
          updated_at: now,
        },
        select: { id: true },
      })
      userId = created.id
    }

    await tx.access_requests.update({
      where: { id: requestId },
      data: {
        status: 'approved',
        reviewed_by: admin.username,
        reviewed_at: now,
        review_note: note ?? null,
        approved_user_id: userId,
      },
      select: { id: true },
    })

    return tx.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        display_name: true,
        role: true,
        provider: true,
        email: true,
        avatar_url: true,
        is_approved: true,
      },
    })
  })

  await prisma.audit_log.create({
    data: {
      action: 'access_request_approved',
      actor: admin.username,
      actor_id: admin.id,
      detail: JSON.stringify({ request_id: requestId, email, role, user_id: user?.id, note }),
      created_at: now,
    },
  })

  return NextResponse.json({ ok: true, user })
}
