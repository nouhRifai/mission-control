import { NextRequest, NextResponse } from 'next/server'
import { db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { validateBody, createWorkflowSchema } from '@/lib/validation'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { scanForInjection } from '@/lib/injection-guard'
import { getPrismaClient } from '@/lib/prisma'

export interface WorkflowTemplate {
  id: number
  name: string
  description: string | null
  model: string
  task_prompt: string
  timeout_seconds: number
  agent_role: string | null
  tags: string | null
  created_by: string
  created_at: number
  updated_at: number
  last_used_at: number | null
  use_count: number
}

/**
 * GET /api/workflows - List all workflow templates
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    const templates = (await prisma.workflow_templates.findMany({
      where: { workspace_id: workspaceId },
      orderBy: [{ use_count: 'desc' }, { updated_at: 'desc' }],
    })) as unknown as WorkflowTemplate[]

    const parsed = templates.map(t => ({
      ...t,
      tags: t.tags ? JSON.parse(t.tags) : [],
    }))

    return NextResponse.json({ templates: parsed })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/workflows error')
    return NextResponse.json({ error: 'Failed to fetch templates' }, { status: 500 })
  }
}

/**
 * POST /api/workflows - Create a new workflow template
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const result = await validateBody(request, createWorkflowSchema)
    if ('error' in result) return result.error
    const { name, description, model, task_prompt, timeout_seconds, agent_role, tags } = result.data

    // Scan task_prompt for injection — this gets sent directly to AI agents
    const injectionReport = scanForInjection(task_prompt, { context: 'prompt' })
    if (!injectionReport.safe) {
      const criticals = injectionReport.matches.filter(m => m.severity === 'critical')
      if (criticals.length > 0) {
        logger.warn({ name, rules: criticals.map(m => m.rule) }, 'Blocked workflow: injection detected in task_prompt')
        return NextResponse.json(
          { error: 'Task prompt blocked: potentially unsafe content detected', injection: criticals.map(m => ({ rule: m.rule, description: m.description })) },
          { status: 422 }
        )
      }
    }

    const prisma = getPrismaClient()
    const user = auth.user
    const workspaceId = auth.user.workspace_id ?? 1

    const now = Math.floor(Date.now() / 1000)
    const template = (await prisma.workflow_templates.create({
      data: {
        name,
        description: description || null,
        model,
        task_prompt,
        timeout_seconds,
        agent_role: agent_role || null,
        tags: JSON.stringify(tags),
        created_by: user?.username || 'system',
        workspace_id: workspaceId,
        created_at: now,
        updated_at: now,
      } as any,
    })) as unknown as WorkflowTemplate

    db_helpers.logActivity(
      'workflow_created',
      'workflow',
      template.id,
      user?.username || 'system',
      `Created workflow template: ${name}`,
      undefined,
      workspaceId
    )

    return NextResponse.json({
      template: { ...template, tags: template.tags ? JSON.parse(template.tags) : [] }
    }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/workflows error')
    return NextResponse.json({ error: 'Failed to create template' }, { status: 500 })
  }
}

/**
 * PUT /api/workflows - Update a workflow template
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { id, ...updates } = body

    if (!id) {
      return NextResponse.json({ error: 'Template ID is required' }, { status: 400 })
    }

    const existing = await prisma.workflow_templates.findFirst({
      where: { id: Number(id), workspace_id: workspaceId },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }

    const data: any = {}

    if (updates.name !== undefined) data.name = updates.name
    if (updates.description !== undefined) data.description = updates.description
    if (updates.model !== undefined) data.model = updates.model
    if (updates.task_prompt !== undefined) data.task_prompt = updates.task_prompt
    if (updates.timeout_seconds !== undefined) data.timeout_seconds = updates.timeout_seconds
    if (updates.agent_role !== undefined) data.agent_role = updates.agent_role
    if (updates.tags !== undefined) data.tags = JSON.stringify(updates.tags)

    // No explicit field updates = usage tracking call (from orchestration bar)
    if (Object.keys(data).length === 0) {
      data.use_count = { increment: 1 }
      data.last_used_at = Math.floor(Date.now() / 1000)
    }

    data.updated_at = Math.floor(Date.now() / 1000)
    await prisma.workflow_templates.updateMany({
      where: { id: Number(id), workspace_id: workspaceId },
      data,
    })

    const updated = (await prisma.workflow_templates.findFirst({
      where: { id: Number(id), workspace_id: workspaceId },
    })) as unknown as WorkflowTemplate | null
    if (!updated) return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    return NextResponse.json({ template: { ...updated, tags: updated.tags ? JSON.parse(updated.tags) : [] } })
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/workflows error')
    return NextResponse.json({ error: 'Failed to update template' }, { status: 500 })
  }
}

/**
 * DELETE /api/workflows - Delete a workflow template
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Request body required' }, { status: 400 }) }
    const id = body.id

    if (!id) {
      return NextResponse.json({ error: 'Template ID is required' }, { status: 400 })
    }

    const result = await prisma.workflow_templates.deleteMany({ where: { id: parseInt(id), workspace_id: workspaceId } })
    if (result.count === 0) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/workflows error')
    return NextResponse.json({ error: 'Failed to delete template' }, { status: 500 })
  }
}
