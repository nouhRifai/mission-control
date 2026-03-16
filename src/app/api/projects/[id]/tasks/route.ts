import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  ensureTenantWorkspaceAccessAsync,
  ForbiddenError
} from '@/lib/workspaces'
import { getPrismaClient } from '@/lib/prisma'

function formatTicketRef(prefix?: string | null, num?: number | null): string | undefined {
  if (!prefix || typeof num !== 'number' || !Number.isFinite(num) || num <= 0) return undefined
  return `${prefix}-${String(num).padStart(3, '0')}`
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
      route: '/api/projects/[id]/tasks',
      ipAddress: forwardedFor,
      userAgent: request.headers.get('user-agent'),
    })
    const { id } = await params
    const projectId = Number.parseInt(id, 10)
    if (!Number.isFinite(projectId)) {
      return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
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
        created_at: true,
        updated_at: true,
      },
    })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const tasks = await prisma.tasks.findMany({
      where: { workspace_id: workspaceId, project_id: projectId },
      orderBy: { created_at: 'desc' },
    })

    return NextResponse.json({
      project,
      tasks: tasks.map((task: any) => ({
        ...task,
        project_name: project.name,
        project_prefix: project.ticket_prefix,
        tags: task.tags ? JSON.parse(task.tags) : [],
        metadata: task.metadata ? JSON.parse(task.metadata) : {},
        ticket_ref: formatTicketRef(task.project_prefix, task.project_ticket_no),
      }))
    })
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    logger.error({ err: error }, 'GET /api/projects/[id]/tasks error')
    return NextResponse.json({ error: 'Failed to fetch project tasks' }, { status: 500 })
  }
}
