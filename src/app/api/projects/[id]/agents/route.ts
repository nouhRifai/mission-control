import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import {
  ensureTenantWorkspaceAccessAsync,
  ForbiddenError
} from '@/lib/workspaces'
import { getPrismaClient } from '@/lib/prisma'

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
      route: '/api/projects/[id]/agents',
      ipAddress: forwardedFor,
      userAgent: request.headers.get('user-agent'),
    })
    const { id } = await params
    const projectId = toProjectId(id)
    if (Number.isNaN(projectId)) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
    const project = await prisma.projects.findFirst({
      where: { id: projectId, workspace_id: workspaceId },
      select: { id: true },
    })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const assignments = await prisma.project_agent_assignments.findMany({
      where: { project_id: projectId },
      select: { id: true, project_id: true, agent_name: true, role: true, assigned_at: true },
      orderBy: { assigned_at: 'asc' },
    })

    return NextResponse.json({ assignments })
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    logger.error({ err: error }, 'GET /api/projects/[id]/agents error')
    return NextResponse.json({ error: 'Failed to fetch agent assignments' }, { status: 500 })
  }
}

export async function POST(
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
      route: '/api/projects/[id]/agents',
      ipAddress: forwardedFor,
      userAgent: request.headers.get('user-agent'),
    })
    const { id } = await params
    const projectId = toProjectId(id)
    if (Number.isNaN(projectId)) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
    const project = await prisma.projects.findFirst({
      where: { id: projectId, workspace_id: workspaceId },
      select: { id: true },
    })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const body = await request.json()
    const agentName = String(body?.agent_name || '').trim()
    const role = String(body?.role || 'member').trim()

    if (!agentName) return NextResponse.json({ error: 'agent_name is required' }, { status: 400 })

    try {
      await prisma.project_agent_assignments.create({
        data: { project_id: projectId, agent_name: agentName, role },
        select: { id: true },
      })
    } catch (err: any) {
      // Unique constraint violation (already assigned) should behave like INSERT OR IGNORE.
      if (err?.code !== 'P2002') throw err
    }

    return NextResponse.json({ success: true }, { status: 201 })
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    logger.error({ err: error }, 'POST /api/projects/[id]/agents error')
    return NextResponse.json({ error: 'Failed to assign agent' }, { status: 500 })
  }
}

export async function DELETE(
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
      route: '/api/projects/[id]/agents',
      ipAddress: forwardedFor,
      userAgent: request.headers.get('user-agent'),
    })
    const { id } = await params
    const projectId = toProjectId(id)
    if (Number.isNaN(projectId)) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
    const project = await prisma.projects.findFirst({
      where: { id: projectId, workspace_id: workspaceId },
      select: { id: true },
    })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const agentName = new URL(request.url).searchParams.get('agent_name')
    if (!agentName) return NextResponse.json({ error: 'agent_name query parameter is required' }, { status: 400 })

    await prisma.project_agent_assignments.deleteMany({
      where: { project_id: projectId, agent_name: agentName },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    logger.error({ err: error }, 'DELETE /api/projects/[id]/agents error')
    return NextResponse.json({ error: 'Failed to unassign agent' }, { status: 500 })
  }
}
