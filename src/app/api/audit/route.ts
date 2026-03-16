import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getPrismaClient } from '@/lib/prisma'

function safeParseJson(str: string): any {
  try { return JSON.parse(str) } catch { return str }
}

/**
 * GET /api/audit - Query audit log (admin only)
 * Query params: action, actor, limit, offset, since, until
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action')
  const actor = searchParams.get('actor')
  const limit = Math.min(parseInt(searchParams.get('limit') || '1000'), 10000)
  const offset = parseInt(searchParams.get('offset') || '0')
  const since = searchParams.get('since')
  const until = searchParams.get('until')

  const prisma = getPrismaClient()
  const where: any = {}
  if (action) where.action = action
  if (actor) where.actor = actor
  const sinceInt = since ? parseInt(since) : NaN
  const untilInt = until ? parseInt(until) : NaN
  if (!Number.isNaN(sinceInt) || !Number.isNaN(untilInt)) {
    where.created_at = {
      ...(!Number.isNaN(sinceInt) ? { gte: sinceInt } : {}),
      ...(!Number.isNaN(untilInt) ? { lte: untilInt } : {}),
    }
  }

  const total = await prisma.audit_log.count({ where })
  const rows = await prisma.audit_log.findMany({
    where,
    orderBy: { created_at: 'desc' },
    take: limit,
    skip: offset,
  })

  return NextResponse.json({
    events: rows.map((row: any) => ({
      ...row,
      detail: row.detail ? safeParseJson(row.detail) : null,
    })),
    total,
    limit,
    offset,
  })
}
