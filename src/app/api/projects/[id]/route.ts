import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import {
  ensureTenantWorkspaceAccessAsync,
  ForbiddenError
} from '@/lib/workspaces'
import { getPrismaClient } from '@/lib/prisma'

function normalizePrefix(input: string): string {
  const normalized = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return normalized.slice(0, 12)
}

function toProjectId(raw: string): number {
  const id = Number.parseInt(raw, 10)
  return Number.isFinite(id) ? id : NaN
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
      route: '/api/projects/[id]',
      ipAddress: forwardedFor,
      userAgent: request.headers.get('user-agent'),
    })
    const { id } = await params
    const projectId = toProjectId(id)
    if (Number.isNaN(projectId)) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })

    const project = await prisma.projects.findFirst({
      where: { id: projectId, workspace_id: workspaceId },
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
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const [taskCount, assignments] = await Promise.all([
      prisma.tasks.count({ where: { project_id: projectId } }),
      prisma.project_agent_assignments.findMany({
        where: { project_id: projectId },
        select: { agent_name: true },
      }),
    ])

    return NextResponse.json({
      project: {
        ...project,
        task_count: taskCount,
        assigned_agents: assignments.map((a) => a.agent_name),
      },
    })
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    logger.error({ err: error }, 'GET /api/projects/[id] error')
    return NextResponse.json({ error: 'Failed to fetch project' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
      route: '/api/projects/[id]',
      ipAddress: forwardedFor,
      userAgent: request.headers.get('user-agent'),
    })
    const { id } = await params
    const projectId = toProjectId(id)
    if (Number.isNaN(projectId)) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
    const current = await prisma.projects.findFirst({
      where: { id: projectId, workspace_id: workspaceId },
      select: { id: true, slug: true },
    })
    if (!current) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const body = await request.json()
    if (current.slug === 'general' && body?.status === 'archived') {
      return NextResponse.json({ error: 'Default project cannot be archived' }, { status: 400 })
    }

    const data: any = {}
    if (typeof body?.name === 'string') {
      const name = body.name.trim()
      if (!name) return NextResponse.json({ error: 'Project name cannot be empty' }, { status: 400 })
      data.name = name
    }
    if (typeof body?.description === 'string') {
      data.description = body.description.trim() || null
    }
    if (typeof body?.ticket_prefix === 'string' || typeof body?.ticketPrefix === 'string') {
      const raw = String(body.ticket_prefix ?? body.ticketPrefix)
      const prefix = normalizePrefix(raw)
      if (!prefix) return NextResponse.json({ error: 'Invalid ticket prefix' }, { status: 400 })
      const conflict = await prisma.projects.findFirst({
        where: { workspace_id: workspaceId, ticket_prefix: prefix, id: { not: projectId } },
        select: { id: true },
      })
      if (conflict) return NextResponse.json({ error: 'Ticket prefix already in use' }, { status: 409 })
      data.ticket_prefix = prefix
    }
    if (typeof body?.status === 'string') {
      data.status = body.status === 'archived' ? 'archived' : 'active'
    }
    if (body?.github_repo !== undefined) {
      data.github_repo = typeof body.github_repo === 'string' ? body.github_repo.trim() || null : null
    }
    if (body?.deadline !== undefined) {
      data.deadline = typeof body.deadline === 'number' ? body.deadline : null
    }
    if (body?.color !== undefined) {
      data.color = typeof body.color === 'string' ? body.color.trim() || null : null
    }
    if (body?.github_sync_enabled !== undefined) {
      data.github_sync_enabled = body.github_sync_enabled ? 1 : 0
    }
    if (body?.github_default_branch !== undefined) {
      data.github_default_branch = typeof body.github_default_branch === 'string'
        ? body.github_default_branch.trim() || 'main'
        : 'main'
    }
    if (body?.github_labels_initialized !== undefined) {
      data.github_labels_initialized = body.github_labels_initialized ? 1 : 0
    }

    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
    data.updated_at = Math.floor(Date.now() / 1000)

    try {
      await prisma.projects.updateMany({
        where: { id: projectId, workspace_id: workspaceId },
        data,
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return NextResponse.json({ error: 'Project slug or ticket prefix already exists' }, { status: 409 })
      }
      throw err
    }

    const project = await prisma.projects.findFirst({
      where: { id: projectId, workspace_id: workspaceId },
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

    return NextResponse.json({ project })
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    logger.error({ err: error }, 'PATCH /api/projects/[id] error')
    return NextResponse.json({ error: 'Failed to update project' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'admin')
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
      route: '/api/projects/[id]',
      ipAddress: forwardedFor,
      userAgent: request.headers.get('user-agent'),
    })
    const { id } = await params
    const projectId = toProjectId(id)
    if (Number.isNaN(projectId)) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
    const current = await prisma.projects.findFirst({
      where: { id: projectId, workspace_id: workspaceId },
      select: { id: true, slug: true, name: true },
    })
    if (!current) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (current.slug === 'general') return NextResponse.json({ error: 'Default project cannot be deleted' }, { status: 400 })

    const mode = new URL(request.url).searchParams.get('mode') || 'archive'
    if (mode !== 'delete') {
      const now = Math.floor(Date.now() / 1000)
      await prisma.projects.updateMany({
        where: { id: projectId, workspace_id: workspaceId },
        data: { status: 'archived', updated_at: now },
      })
      return NextResponse.json({ success: true, mode: 'archive' })
    }

    const fallback = await prisma.projects.findFirst({
      where: { workspace_id: workspaceId, slug: 'general' },
      select: { id: true },
    })
    if (!fallback) return NextResponse.json({ error: 'Default project missing' }, { status: 500 })

    await prisma.$transaction(async (tx) => {
      await tx.tasks.updateMany({
        where: { workspace_id: workspaceId, project_id: projectId },
        data: { project_id: fallback.id },
      })
      await tx.projects.deleteMany({ where: { id: projectId, workspace_id: workspaceId } })
    })

    return NextResponse.json({ success: true, mode: 'delete' })
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    logger.error({ err: error }, 'DELETE /api/projects/[id] error')
    return NextResponse.json({ error: 'Failed to delete project' }, { status: 500 })
  }
}
