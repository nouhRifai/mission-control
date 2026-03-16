import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/db'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'

/**
 * GET /api/workspaces/[id] - Get a single workspace
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const { id } = await params
    const tenantId = auth.user.tenant_id ?? 1

    const workspaceId = Number(id)
    const workspace = await prisma.workspaces.findFirst({
      where: { id: workspaceId, tenant_id: tenantId },
    })

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    }

    // Include agent count
    const agentCount = await prisma.agents.count({ where: { workspace_id: workspaceId } })

    return NextResponse.json({
      workspace: { ...(workspace as any), agent_count: agentCount },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/workspaces/[id] error')
    return NextResponse.json({ error: 'Failed to fetch workspace' }, { status: 500 })
  }
}

/**
 * PUT /api/workspaces/[id] - Update workspace name
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const { id } = await params
    const tenantId = auth.user.tenant_id ?? 1
    const body = await request.json()
    const { name } = body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    const workspaceId = Number(id)
    const existing = await prisma.workspaces.findFirst({
      where: { id: workspaceId, tenant_id: tenantId },
      select: { id: true, name: true },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    }

    // Don't allow renaming the default workspace slug
    const now = Math.floor(Date.now() / 1000)
    await prisma.workspaces.updateMany({
      where: { id: workspaceId, tenant_id: tenantId },
      data: { name: name.trim(), updated_at: now },
    })

    logAuditEvent({
      action: 'workspace_updated',
      actor: auth.user.username,
      actor_id: auth.user.id,
      target_type: 'workspace',
      target_id: workspaceId,
      detail: { old_name: existing.name, new_name: name.trim() },
    })

    const updated = await prisma.workspaces.findUnique({ where: { id: workspaceId } })
    return NextResponse.json({ workspace: updated })
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/workspaces/[id] error')
    return NextResponse.json({ error: 'Failed to update workspace' }, { status: 500 })
  }
}

/**
 * DELETE /api/workspaces/[id] - Delete a workspace (moves agents to default workspace)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const { id } = await params
    const tenantId = auth.user.tenant_id ?? 1
    const workspaceId = Number(id)

    const existing = await prisma.workspaces.findFirst({
      where: { id: workspaceId, tenant_id: tenantId },
      select: { id: true, slug: true, name: true },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    }

    if (existing.slug === 'default') {
      return NextResponse.json({ error: 'Cannot delete the default workspace' }, { status: 400 })
    }

    // Find default workspace to reassign agents
    const defaultWs = await prisma.workspaces.findFirst({
      where: { slug: 'default', tenant_id: tenantId },
      select: { id: true },
    })

    const fallbackId = defaultWs?.id ?? 1
    const now = Math.floor(Date.now() / 1000)

    const moved = await prisma.$transaction(async (tx) => {
      const movedAgents = await tx.agents.updateMany({
        where: { workspace_id: workspaceId },
        data: { workspace_id: fallbackId, updated_at: now },
      })

      await tx.users.updateMany({
        where: { workspace_id: workspaceId },
        data: { workspace_id: fallbackId, updated_at: now },
      })

      await tx.projects.updateMany({
        where: { workspace_id: workspaceId },
        data: { workspace_id: fallbackId, updated_at: now },
      })

      await tx.workspaces.deleteMany({ where: { id: workspaceId, tenant_id: tenantId } })
      return movedAgents.count
    })

    logAuditEvent({
      action: 'workspace_deleted',
      actor: auth.user.username,
      actor_id: auth.user.id,
      target_type: 'workspace',
      target_id: workspaceId,
      detail: {
        name: existing.name,
        slug: existing.slug,
        agents_moved: moved,
        moved_to_workspace: fallbackId,
      },
    })

    return NextResponse.json({
      success: true,
      deleted: existing.name,
      agents_moved_to: fallbackId,
    })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/workspaces/[id] error')
    return NextResponse.json({ error: 'Failed to delete workspace' }, { status: 500 })
  }
}
