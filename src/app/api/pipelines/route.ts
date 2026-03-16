import { NextRequest, NextResponse } from 'next/server'
import { db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { validateBody, createPipelineSchema } from '@/lib/validation'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'

export interface PipelineStep {
  template_id: number
  template_name?: string
  on_failure: 'stop' | 'continue'
}

export interface Pipeline {
  id: number
  name: string
  description: string | null
  steps: string // JSON array of PipelineStep
  created_by: string
  created_at: number
  updated_at: number
  use_count: number
  last_used_at: number | null
}

/**
 * GET /api/pipelines - List all pipelines with enriched step data
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    const pipelines = (await prisma.workflow_pipelines.findMany({
      where: { workspace_id: workspaceId },
      orderBy: [{ use_count: 'desc' }, { updated_at: 'desc' }],
    })) as unknown as Pipeline[]

    // Enrich steps with template names
    const templates = await prisma.workflow_templates.findMany({
      where: { workspace_id: workspaceId },
      select: { id: true, name: true },
    })
    const nameMap = new Map(templates.map(t => [t.id, t.name]))

    // Get run counts per pipeline
    const runCounts = await prisma.$queryRaw<Array<{ pipeline_id: number; total: number; completed: number; failed: number; running: number }>>`
      SELECT pipeline_id, COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
      FROM pipeline_runs WHERE workspace_id = ${workspaceId} GROUP BY pipeline_id
    `
    const runMap = new Map(runCounts.map(r => [r.pipeline_id, r]))

    const parsed = pipelines.map(p => {
      const steps: PipelineStep[] = JSON.parse(p.steps || '[]')
      return {
        ...p,
        steps: steps.map(s => ({ ...s, template_name: nameMap.get(s.template_id) || 'Unknown' })),
        runs: runMap.get(p.id) || { total: 0, completed: 0, failed: 0, running: 0 },
      }
    })

    return NextResponse.json({ pipelines: parsed })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/pipelines error')
    return NextResponse.json({ error: 'Failed to fetch pipelines' }, { status: 500 })
  }
}

/**
 * POST /api/pipelines - Create a pipeline
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const result = await validateBody(request, createPipelineSchema)
    if ('error' in result) return result.error
    const { name, description, steps } = result.data

    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1

    // Validate template IDs exist
    const templateIds = steps.map((s: PipelineStep) => s.template_id)
    const existing = await prisma.workflow_templates.findMany({
      where: { workspace_id: workspaceId, id: { in: templateIds } },
      select: { id: true },
    })
    if (existing.length !== new Set(templateIds).size) {
      return NextResponse.json({ error: 'One or more template IDs not found' }, { status: 400 })
    }

    const cleanSteps = steps.map((s: PipelineStep) => ({
      template_id: s.template_id,
      on_failure: s.on_failure || 'stop',
    }))

    const now = Math.floor(Date.now() / 1000)
    const created = (await prisma.workflow_pipelines.create({
      data: {
        name,
        description: description || null,
        steps: JSON.stringify(cleanSteps),
        created_by: auth.user?.username || 'system',
        workspace_id: workspaceId,
        created_at: now,
        updated_at: now,
      } as any,
    })) as unknown as Pipeline

    db_helpers.logActivity(
      'pipeline_created',
      'pipeline',
      created.id,
      auth.user?.username || 'system',
      `Created pipeline: ${name}`,
      undefined,
      workspaceId
    )

    return NextResponse.json({ pipeline: { ...created, steps: JSON.parse(created.steps) } }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/pipelines error')
    return NextResponse.json({ error: 'Failed to create pipeline' }, { status: 500 })
  }
}

/**
 * PUT /api/pipelines - Update a pipeline
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { id, ...updates } = body

    if (!id) return NextResponse.json({ error: 'Pipeline ID required' }, { status: 400 })

    const existing = await prisma.workflow_pipelines.findFirst({
      where: { id: Number(id), workspace_id: workspaceId },
    }) as unknown as Pipeline | null
    if (!existing) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })

    const data: any = {}

    if (updates.name !== undefined) data.name = updates.name
    if (updates.description !== undefined) data.description = updates.description
    if (updates.steps !== undefined) {
      data.steps = JSON.stringify(updates.steps)
    }

    if (Object.keys(data).length === 0) {
      // Usage tracking
      data.use_count = { increment: 1 }
      data.last_used_at = Math.floor(Date.now() / 1000)
    }

    data.updated_at = Math.floor(Date.now() / 1000)
    await prisma.workflow_pipelines.updateMany({
      where: { id: Number(id), workspace_id: workspaceId },
      data,
    })

    const updated = await prisma.workflow_pipelines.findFirst({
      where: { id: Number(id), workspace_id: workspaceId },
    }) as unknown as Pipeline | null
    if (!updated) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })
    return NextResponse.json({ pipeline: { ...updated, steps: JSON.parse(updated.steps) } })
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/pipelines error')
    return NextResponse.json({ error: 'Failed to update pipeline' }, { status: 500 })
  }
}

/**
 * DELETE /api/pipelines - Delete a pipeline
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Request body required' }, { status: 400 }) }
    const id = body.id
    if (!id) return NextResponse.json({ error: 'Pipeline ID required' }, { status: 400 })

    await prisma.workflow_pipelines.deleteMany({ where: { id: parseInt(id), workspace_id: workspaceId } })
    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/pipelines error')
    return NextResponse.json({ error: 'Failed to delete pipeline' }, { status: 500 })
  }
}
