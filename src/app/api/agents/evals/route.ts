import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { readLimiter, mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'
import {
  runOutputEvals,
  evalReasoningCoherence,
  evalToolReliability,
  runDriftCheck,
  getDriftTimeline,
  type EvalResult,
} from '@/lib/agent-evals'

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = readLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const { searchParams } = new URL(request.url)
    const agent = searchParams.get('agent')
    const action = searchParams.get('action')
    const workspaceId = auth.user.workspace_id ?? 1

    if (!agent) {
      return NextResponse.json({ error: 'Missing required parameter: agent' }, { status: 400 })
    }

    // History mode
    if (action === 'history') {
      const weeks = parseInt(searchParams.get('weeks') || '4', 10)
      const prisma = getPrismaClient()

      const history = await prisma.eval_runs.findMany({
        where: { agent_name: agent, workspace_id: workspaceId },
        select: { eval_layer: true, score: true, passed: true, detail: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: weeks * 7,
      })

      const driftTimeline = await getDriftTimeline(agent, weeks, workspaceId)

      return NextResponse.json({
        agent,
        history,
        driftTimeline,
      })
    }

    // Default: latest eval results per layer
    const prisma = getPrismaClient()
    const recentRuns = await prisma.eval_runs.findMany({
      where: { agent_name: agent, workspace_id: workspaceId },
      select: { eval_layer: true, score: true, passed: true, detail: true, created_at: true },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: 500,
    })
    const seen = new Set<string>()
    const latestByLayer: any[] = []
    for (const row of recentRuns) {
      if (seen.has(row.eval_layer)) continue
      seen.add(row.eval_layer)
      latestByLayer.push(row)
    }

    const driftResults = await runDriftCheck(agent, workspaceId)
    const hasDrift = driftResults.some(d => d.drifted)

    return NextResponse.json({
      agent,
      layers: latestByLayer,
      drift: {
        hasDrift,
        metrics: driftResults,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/evals error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body

    if (action === 'run') {
      const auth = await requireRole(request, 'operator')
      if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

      const rateCheck = mutationLimiter(request)
      if (rateCheck) return rateCheck

      const { agent, layer } = body
      if (!agent) return NextResponse.json({ error: 'Missing: agent' }, { status: 400 })

      const workspaceId = auth.user.workspace_id ?? 1
      const prisma = getPrismaClient()
      const now = Math.floor(Date.now() / 1000)
      const results: EvalResult[] = []

      const layers = layer ? [layer] : ['output', 'trace', 'component', 'drift']

      for (const l of layers) {
        let evalResults: EvalResult[] = []
        switch (l) {
          case 'output':
            evalResults = await runOutputEvals(agent, 168, workspaceId)
            break
          case 'trace':
            evalResults = [await evalReasoningCoherence(agent, 24, workspaceId)]
            break
          case 'component':
            evalResults = [await evalToolReliability(agent, 24, workspaceId)]
            break
          case 'drift': {
            const driftResults = await runDriftCheck(agent, workspaceId)
            const driftScore = driftResults.filter(d => !d.drifted).length / Math.max(driftResults.length, 1)
            evalResults = [{
              layer: 'drift',
              score: Math.round(driftScore * 100) / 100,
              passed: !driftResults.some(d => d.drifted),
              detail: driftResults.map(d => `${d.metric}: ${d.drifted ? 'DRIFTED' : 'stable'} (delta=${d.delta})`).join('; '),
            }]
            break
          }
        }

        for (const r of evalResults) {
          await prisma.eval_runs.create({
            data: {
              agent_name: agent,
              eval_layer: r.layer,
              score: r.score,
              passed: r.passed ? 1 : 0,
              detail: r.detail,
              workspace_id: workspaceId,
              created_at: now,
            },
            select: { id: true },
          })
          results.push(r)
        }
      }

      return NextResponse.json({ agent, results })
    }

    if (action === 'golden-set') {
      const auth = await requireRole(request, 'admin')
      if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

      const rateCheck = mutationLimiter(request)
      if (rateCheck) return rateCheck

      const { name, entries } = body
      if (!name) return NextResponse.json({ error: 'Missing: name' }, { status: 400 })

      const workspaceId = auth.user.workspace_id ?? 1
      const prisma = getPrismaClient()
      const now = Math.floor(Date.now() / 1000)

      await prisma.eval_golden_sets.upsert({
        where: { name_workspace_id: { name, workspace_id: workspaceId } } as any,
        create: {
          name,
          entries: JSON.stringify(entries || []),
          created_by: auth.user.username,
          workspace_id: workspaceId,
          created_at: now,
          updated_at: now,
        },
        update: {
          entries: JSON.stringify(entries || []),
          updated_at: now,
        },
        select: { id: true },
      })

      return NextResponse.json({ success: true, name })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents/evals error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
