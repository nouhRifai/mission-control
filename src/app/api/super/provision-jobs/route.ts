import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getPrismaClient } from '@/lib/prisma'

/**
 * GET /api/super/provision-jobs - List provisioning jobs
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { searchParams } = new URL(request.url)
  const tenant_id = searchParams.get('tenant_id')
  const status = searchParams.get('status') || undefined
  const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 200)

  const prisma = getPrismaClient()
  const jobs = await prisma.provision_jobs.findMany({
    where: {
      ...(tenant_id ? { tenant_id: parseInt(tenant_id, 10) } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: limit,
  })

  return NextResponse.json({ jobs })
}

/**
 * POST /api/super/provision-jobs - Queue an additional bootstrap/update job for an existing tenant
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const body = await request.json()
    const tenantId = Number(body.tenant_id)
    const dryRun = body.dry_run !== false
    const jobType = String(body.job_type || 'bootstrap')

    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return NextResponse.json({ error: 'tenant_id is required' }, { status: 400 })
    }

    if (!['bootstrap', 'update', 'decommission'].includes(jobType)) {
      return NextResponse.json({ error: 'Invalid job_type' }, { status: 400 })
    }

    const tenant = await prisma.tenants.findUnique({ where: { id: tenantId }, select: { id: true } }) as any
    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })
    }

    const plan = body.plan_json && Array.isArray(body.plan_json) ? body.plan_json : []
    const now = Math.floor(Date.now() / 1000)
    const created = await prisma.provision_jobs.create({
      data: {
        tenant_id: tenantId,
        job_type: jobType,
        status: 'queued',
        dry_run: dryRun ? 1 : 0,
        requested_by: auth.user.username,
        request_json: JSON.stringify(body.request_json || {}),
        plan_json: JSON.stringify(plan),
        created_at: now,
        updated_at: now,
      },
    })
    const id = created.id
    return NextResponse.json({
      job: created,
    }, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to queue job' }, { status: 500 })
  }
}
