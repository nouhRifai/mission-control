import { NextRequest, NextResponse } from 'next/server'
import { db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'

interface PipelineStep {
  template_id: number
  on_failure: 'stop' | 'continue'
}

interface RunStepState {
  step_index: number
  template_id: number
  template_name: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  spawn_id: string | null
  started_at: number | null
  completed_at: number | null
  error: string | null
}

interface PipelineRun {
  id: number
  pipeline_id: number
  status: string
  current_step: number
  steps_snapshot: string
  started_at: number | null
  completed_at: number | null
  triggered_by: string
  created_at: number
}

/**
 * GET /api/pipelines/run - Get pipeline runs
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const { searchParams } = new URL(request.url)
    const workspaceId = auth.user.workspace_id ?? 1
    const pipelineId = searchParams.get('pipeline_id')
    const runId = searchParams.get('id')
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 200)

    if (runId) {
      const run = (await prisma.pipeline_runs.findFirst({
        where: { id: parseInt(runId), workspace_id: workspaceId },
      })) as unknown as PipelineRun | null
      if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
      return NextResponse.json({ run: { ...run, steps_snapshot: JSON.parse(run.steps_snapshot) } })
    }

    const pipelineIdInt = pipelineId ? parseInt(pipelineId) : null
    const runs = (await prisma.pipeline_runs.findMany({
      where: { workspace_id: workspaceId, ...(pipelineIdInt ? { pipeline_id: pipelineIdInt } : {}) } as any,
      orderBy: { created_at: 'desc' },
      take: limit,
    })) as unknown as PipelineRun[]

    // Enrich with pipeline names
    const pipelineIds = [...new Set(runs.map(r => r.pipeline_id))]
    const pipelines = pipelineIds.length > 0
      ? await prisma.workflow_pipelines.findMany({
          where: { workspace_id: workspaceId, id: { in: pipelineIds } },
          select: { id: true, name: true },
        })
      : []
    const nameMap = new Map(pipelines.map(p => [p.id, p.name]))

    const parsed = runs.map(r => ({
      ...r,
      pipeline_name: nameMap.get(r.pipeline_id) || 'Deleted Pipeline',
      steps_snapshot: JSON.parse(r.steps_snapshot),
    }))

    return NextResponse.json({ runs: parsed })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/pipelines/run error')
    return NextResponse.json({ error: 'Failed to fetch runs' }, { status: 500 })
  }
}

/**
 * POST /api/pipelines/run - Start a pipeline run or advance a running one
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()
    const { action, pipeline_id, run_id } = body

    if (action === 'start') {
      return startPipeline(prisma, pipeline_id, auth.user?.username || 'system', workspaceId)
    } else if (action === 'advance') {
      return advanceRun(prisma, run_id, body.success ?? true, body.error, workspaceId)
    } else if (action === 'cancel') {
      return cancelRun(prisma, run_id, workspaceId)
    }

    return NextResponse.json({ error: 'Invalid action. Use: start, advance, cancel' }, { status: 400 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/pipelines/run error')
    return NextResponse.json({ error: 'Failed to process pipeline run' }, { status: 500 })
  }
}

/** Spawn a single pipeline step using `openclaw agent` */
async function spawnStep(
  prisma: ReturnType<typeof getPrismaClient>,
  pipelineName: string,
  template: { name: string; model: string; task_prompt: string; timeout_seconds: number },
  steps: RunStepState[],
  stepIdx: number,
  runId: number,
  workspaceId: number
): Promise<{ success: boolean; stdout?: string; error?: string }> {
  try {
    const { runOpenClaw } = await import('@/lib/command')
    const args = [
      'agent',
      '--message', `[Pipeline: ${pipelineName} | Step ${stepIdx + 1}] ${template.task_prompt}`,
      '--timeout', String(template.timeout_seconds),
      '--json',
    ]
    const { stdout } = await runOpenClaw(args, { timeoutMs: 15000 })

    const spawnId = `pipeline-${runId}-step-${stepIdx}-${Date.now()}`
    steps[stepIdx].spawn_id = spawnId
    await prisma.pipeline_runs.updateMany({
      where: { id: runId, workspace_id: workspaceId },
      data: { steps_snapshot: JSON.stringify(steps) },
    })

    return { success: true, stdout: stdout.trim() }
  } catch (err: any) {
    // Spawn failed - record error but keep pipeline running for manual advance
    steps[stepIdx].error = err.message
    await prisma.pipeline_runs.updateMany({
      where: { id: runId, workspace_id: workspaceId },
      data: { steps_snapshot: JSON.stringify(steps) },
    })

    return { success: false, error: err.message }
  }
}

async function startPipeline(prisma: ReturnType<typeof getPrismaClient>, pipelineId: number, triggeredBy: string, workspaceId: number) {
  const pipeline = await prisma.workflow_pipelines.findFirst({
    where: { id: pipelineId, workspace_id: workspaceId },
  }) as any
  if (!pipeline) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })

  const steps: PipelineStep[] = JSON.parse(pipeline.steps || '[]')
  if (steps.length === 0) return NextResponse.json({ error: 'Pipeline has no steps' }, { status: 400 })

  // Get template names for snapshot
  const templateIds = steps.map(s => s.template_id)
  const templates = await prisma.workflow_templates.findMany({
    where: { workspace_id: workspaceId, id: { in: templateIds } },
    select: { id: true, name: true, model: true, task_prompt: true, timeout_seconds: true },
  }) as Array<{ id: number; name: string; model: string; task_prompt: string; timeout_seconds: number }>
  const templateMap = new Map(templates.map(t => [t.id, t]))

  // Build step snapshot
  const stepsSnapshot: RunStepState[] = steps.map((s, i) => ({
    step_index: i,
    template_id: s.template_id,
    template_name: templateMap.get(s.template_id)?.name || 'Unknown',
    on_failure: s.on_failure,
    status: i === 0 ? 'running' : 'pending',
    spawn_id: null,
    started_at: i === 0 ? Math.floor(Date.now() / 1000) : null,
    completed_at: null,
    error: null,
  }))

  const now = Math.floor(Date.now() / 1000)
  const created = await prisma.pipeline_runs.create({
    data: {
      pipeline_id: pipelineId,
      status: 'running',
      current_step: 0,
      steps_snapshot: JSON.stringify(stepsSnapshot),
      started_at: now,
      triggered_by: triggeredBy,
      workspace_id: workspaceId,
      created_at: now,
    } as any,
    select: { id: true },
  })

  const runId = created.id

  // Update pipeline usage
  await prisma.workflow_pipelines.updateMany({
    where: { id: pipelineId, workspace_id: workspaceId },
    data: { use_count: { increment: 1 }, last_used_at: now, updated_at: now } as any,
  })

  // Spawn first step
  const firstTemplate = templateMap.get(steps[0].template_id)
  let spawnResult: any = null
  if (firstTemplate) {
    spawnResult = await spawnStep(prisma, pipeline.name, firstTemplate, stepsSnapshot, 0, runId, workspaceId)
  }

  db_helpers.logActivity('pipeline_started', 'pipeline', pipelineId, triggeredBy, `Started pipeline: ${pipeline.name}`, { run_id: runId }, workspaceId)

  eventBus.broadcast('activity.created', {
    type: 'pipeline_started',
    entity_type: 'pipeline',
    entity_id: pipelineId,
    description: `Pipeline "${pipeline.name}" started`,
    data: { run_id: runId },
  })

  return NextResponse.json({
    run: {
      id: runId,
      pipeline_id: pipelineId,
      status: stepsSnapshot[0].status === 'failed' ? 'failed' : 'running',
      current_step: 0,
      steps_snapshot: stepsSnapshot,
      spawn: spawnResult,
    }
  }, { status: 201 })
}

async function advanceRun(prisma: ReturnType<typeof getPrismaClient>, runId: number, success: boolean, errorMsg: string | undefined, workspaceId: number) {
  if (!runId) return NextResponse.json({ error: 'run_id required' }, { status: 400 })

  const run = (await prisma.pipeline_runs.findFirst({
    where: { id: runId, workspace_id: workspaceId },
  })) as unknown as PipelineRun | null
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  if (run.status !== 'running') return NextResponse.json({ error: `Run is ${run.status}, not running` }, { status: 400 })

  const steps: (RunStepState & { on_failure?: string })[] = JSON.parse(run.steps_snapshot)
  const currentIdx = run.current_step
  const now = Math.floor(Date.now() / 1000)

  // Mark current step as completed/failed
  steps[currentIdx].status = success ? 'completed' : 'failed'
  steps[currentIdx].completed_at = now
  if (errorMsg) steps[currentIdx].error = errorMsg

  // Determine next action
  const nextIdx = currentIdx + 1
  const onFailure = steps[currentIdx].on_failure || 'stop'

  if (!success && onFailure === 'stop') {
    // Mark remaining steps as skipped
    for (let i = nextIdx; i < steps.length; i++) steps[i].status = 'skipped'
    await prisma.pipeline_runs.updateMany({
      where: { id: runId, workspace_id: workspaceId },
      data: { status: 'failed', current_step: currentIdx, steps_snapshot: JSON.stringify(steps), completed_at: now },
    })
    return NextResponse.json({ run: { id: runId, status: 'failed', steps_snapshot: steps } })
  }

  if (nextIdx >= steps.length) {
    // Pipeline complete
    const finalStatus = steps.some(s => s.status === 'failed') ? 'completed' : 'completed'
    await prisma.pipeline_runs.updateMany({
      where: { id: runId, workspace_id: workspaceId },
      data: { status: finalStatus, current_step: currentIdx, steps_snapshot: JSON.stringify(steps), completed_at: now },
    })

    eventBus.broadcast('activity.created', {
      type: 'pipeline_completed',
      entity_type: 'pipeline',
      entity_id: run.pipeline_id,
      description: `Pipeline run #${runId} completed`,
    })

    return NextResponse.json({ run: { id: runId, status: finalStatus, steps_snapshot: steps } })
  }

  // Spawn next step
  steps[nextIdx].status = 'running'
  steps[nextIdx].started_at = now

  const template = await prisma.workflow_templates.findFirst({
    where: { id: steps[nextIdx].template_id, workspace_id: workspaceId },
    select: { id: true, name: true, model: true, task_prompt: true, timeout_seconds: true },
  }) as any

  let spawnResult: any = null
  if (template) {
    const pipeline = await prisma.workflow_pipelines.findFirst({
      where: { id: run.pipeline_id, workspace_id: workspaceId },
      select: { name: true },
    }) as any
    spawnResult = await spawnStep(prisma, pipeline?.name || '?', template, steps, nextIdx, runId, workspaceId)
  }

  await prisma.pipeline_runs.updateMany({
    where: { id: runId, workspace_id: workspaceId },
    data: { current_step: nextIdx, steps_snapshot: JSON.stringify(steps) },
  })

  return NextResponse.json({
    run: { id: runId, status: 'running', current_step: nextIdx, steps_snapshot: steps, spawn: spawnResult }
  })
}

async function cancelRun(prisma: ReturnType<typeof getPrismaClient>, runId: number, workspaceId: number) {
  if (!runId) return NextResponse.json({ error: 'run_id required' }, { status: 400 })

  const run = (await prisma.pipeline_runs.findFirst({
    where: { id: runId, workspace_id: workspaceId },
  })) as unknown as PipelineRun | null
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  if (run.status !== 'running' && run.status !== 'pending') {
    return NextResponse.json({ error: `Run is ${run.status}, cannot cancel` }, { status: 400 })
  }

  const steps: RunStepState[] = JSON.parse(run.steps_snapshot)
  const now = Math.floor(Date.now() / 1000)

  for (const step of steps) {
    if (step.status === 'pending' || step.status === 'running') {
      step.status = 'skipped'
      step.completed_at = now
    }
  }

  await prisma.pipeline_runs.updateMany({
    where: { id: runId, workspace_id: workspaceId },
    data: { status: 'cancelled', steps_snapshot: JSON.stringify(steps), completed_at: now },
  })

  return NextResponse.json({ run: { id: runId, status: 'cancelled', steps_snapshot: steps } })
}
