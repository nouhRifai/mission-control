import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { ensureTenantWorkspaceAccessAsync, ForbiddenError } from '@/lib/workspaces'
import { getPrismaClient } from '@/lib/prisma'

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function normalizePrefix(input: string): string {
  const normalized = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return normalized.slice(0, 12)
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    const tenantId = auth.user.tenant_id ?? 1
    const forwardedFor = (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() || null
    await ensureTenantWorkspaceAccessAsync(tenantId, workspaceId, {
      actor: auth.user.username,
      actorId: auth.user.id,
      route: '/api/projects',
      ipAddress: forwardedFor,
      userAgent: request.headers.get('user-agent'),
    })
    const includeArchived = new URL(request.url).searchParams.get('includeArchived') === '1'

    const rows = await prisma.projects.findMany({
      where: {
        workspace_id: workspaceId,
        ...(includeArchived ? {} : { status: 'active' }),
      },
      select: {
        id: true,
        workspace_id: true,
        name: true,
        slug: true,
        description: true,
        ticket_prefix: true,
        ticket_counter: true,
        status: true,
        github_repo: true,
        deadline: true,
        color: true,
        github_sync_enabled: true,
        github_labels_initialized: true,
        github_default_branch: true,
        created_at: true,
        updated_at: true,
        project_agent_assignments: { select: { agent_name: true } },
      },
    })

    const sorted = [...rows].sort((a, b) =>
      String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' })
    )

    const ids = sorted.map((p) => p.id)
    const counts = ids.length === 0
      ? []
      : await prisma.tasks.groupBy({
          by: ['project_id'],
          where: { project_id: { in: ids } },
          _count: { _all: true },
        })
    const countMap = new Map<number, number>()
    for (const row of counts as any[]) {
      if (typeof row.project_id === 'number') countMap.set(row.project_id, row._count?._all ?? 0)
    }

    const projects = sorted.map((p) => ({
      ...p,
      task_count: countMap.get(p.id) ?? 0,
      assigned_agents: (p as any).project_agent_assignments?.map((a: any) => a.agent_name) ?? [],
      project_agent_assignments: undefined,
    }))

    return NextResponse.json({ projects })
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    logger.error({ err: error }, 'GET /api/projects error')
    return NextResponse.json({ error: 'Failed to fetch projects' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    const tenantId = auth.user.tenant_id ?? 1
    const forwardedFor = (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() || null
    await ensureTenantWorkspaceAccessAsync(tenantId, workspaceId, {
      actor: auth.user.username,
      actorId: auth.user.id,
      route: '/api/projects',
      ipAddress: forwardedFor,
      userAgent: request.headers.get('user-agent'),
    })
    const body = await request.json()

    const name = String(body?.name || '').trim()
    const description = typeof body?.description === 'string' ? body.description.trim() : ''
    const prefixInput = String(body?.ticket_prefix || body?.ticketPrefix || '').trim()
    const slugInput = String(body?.slug || '').trim()
    const githubRepo = typeof body?.github_repo === 'string' ? body.github_repo.trim() || null : null
    const deadline = typeof body?.deadline === 'number' ? body.deadline : null
    const color = typeof body?.color === 'string' ? body.color.trim() || null : null

    if (!name) return NextResponse.json({ error: 'Project name is required' }, { status: 400 })

    const slug = slugInput ? slugify(slugInput) : slugify(name)
    const ticketPrefix = normalizePrefix(prefixInput || name.slice(0, 5))
    if (!slug) return NextResponse.json({ error: 'Invalid project slug' }, { status: 400 })
    if (!ticketPrefix) return NextResponse.json({ error: 'Invalid ticket prefix' }, { status: 400 })

    const now = Math.floor(Date.now() / 1000)
    let project: any
    try {
      project = await prisma.projects.create({
        data: {
          workspace_id: workspaceId,
          name,
          slug,
          description: description || null,
          ticket_prefix: ticketPrefix,
          github_repo: githubRepo,
          deadline,
          color,
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        select: {
          id: true,
          workspace_id: true,
          name: true,
          slug: true,
          description: true,
          ticket_prefix: true,
          ticket_counter: true,
          status: true,
          github_repo: true,
          deadline: true,
          color: true,
          github_sync_enabled: true,
          github_labels_initialized: true,
          github_default_branch: true,
          created_at: true,
          updated_at: true,
        },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return NextResponse.json({ error: 'Project slug or ticket prefix already exists' }, { status: 409 })
      }
      throw err
    }

    return NextResponse.json({ project }, { status: 201 })
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    logger.error({ err: error }, 'POST /api/projects error')
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 })
  }
}
