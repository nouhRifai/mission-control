import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { agentTaskLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { getPrismaClient } from '@/lib/prisma'

type QueueReason = 'continue_current' | 'assigned' | 'at_capacity' | 'no_tasks_available'

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function mapTaskRow(task: any) {
  return {
    ...task,
    tags: safeParseJson(task.tags, [] as string[]),
    metadata: safeParseJson(task.metadata, {} as Record<string, unknown>),
  }
}

/**
 * GET /api/tasks/queue - Poll next task for an agent.
 *
 * Query params:
 * - agent: required agent name (or use x-agent-name header)
 * - max_capacity: optional integer 1..20 (default 1)
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateLimited = agentTaskLimiter(request)
  if (rateLimited) return rateLimited

  try {
    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id
    const { searchParams } = new URL(request.url)

    const agent =
      (searchParams.get('agent') || '').trim() ||
      (request.headers.get('x-agent-name') || '').trim()

    if (!agent) {
      return NextResponse.json({ error: 'Missing agent. Provide ?agent=... or x-agent-name header.' }, { status: 400 })
    }

    const maxCapacityRaw = searchParams.get('max_capacity') || '1'
    if (!/^\d+$/.test(maxCapacityRaw)) {
      return NextResponse.json({ error: 'Invalid max_capacity. Expected integer 1..20.' }, { status: 400 })
    }
    const maxCapacity = Number(maxCapacityRaw)
    if (!Number.isInteger(maxCapacity) || maxCapacity < 1 || maxCapacity > 20) {
      return NextResponse.json({ error: 'Invalid max_capacity. Expected integer 1..20.' }, { status: 400 })
    }

    const now = Math.floor(Date.now() / 1000)

    const currentTask = await prisma.tasks.findFirst({
      where: { workspace_id: workspaceId, assigned_to: agent, status: 'in_progress' },
      orderBy: { updated_at: 'desc' },
    })

    if (currentTask) {
      return NextResponse.json({
        task: mapTaskRow(currentTask),
        reason: 'continue_current' as QueueReason,
        agent,
        timestamp: now,
      })
    }

    const inProgressCount = await prisma.tasks.count({
      where: { workspace_id: workspaceId, assigned_to: agent, status: 'in_progress' },
    })

    if (inProgressCount >= maxCapacity) {
      return NextResponse.json({
        task: null,
        reason: 'at_capacity' as QueueReason,
        agent,
        timestamp: now,
      })
    }

    // Best-effort atomic pickup loop for race safety.
    const priorities: Array<string | null> = ['critical', 'high', 'medium', 'low']
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let claimedTask: any | null = null

      for (const priority of priorities) {
        const baseWhere: any = {
          workspace_id: workspaceId,
          status: { in: ['assigned', 'inbox'] },
          OR: [{ assigned_to: null }, { assigned_to: agent }],
          priority,
        }

        // Match legacy ordering: due_date ASC NULLS LAST, created_at ASC within priority.
        const candidate =
          (await prisma.tasks.findFirst({
            where: { ...baseWhere, due_date: { not: null } },
            orderBy: [{ due_date: 'asc' }, { created_at: 'asc' }],
          })) ||
          (await prisma.tasks.findFirst({
            where: { ...baseWhere, due_date: null },
            orderBy: { created_at: 'asc' },
          }))

        if (!candidate) continue

        const claim = await prisma.tasks.updateMany({
          where: {
            id: candidate.id,
            workspace_id: workspaceId,
            status: { in: ['assigned', 'inbox'] },
            OR: [{ assigned_to: null }, { assigned_to: agent }],
          },
          data: { status: 'in_progress', assigned_to: agent, updated_at: now },
        })

        if (claim.count > 0) {
          claimedTask = await prisma.tasks.findFirst({
            where: { id: candidate.id, workspace_id: workspaceId },
          })
          break
        }
      }

      if (claimedTask) {
        return NextResponse.json({
          task: mapTaskRow(claimedTask),
          reason: 'assigned' as QueueReason,
          agent,
          timestamp: now,
        })
      }
    }

    return NextResponse.json({
      task: null,
      reason: 'no_tasks_available' as QueueReason,
      agent,
      timestamp: now,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/queue error')
    return NextResponse.json({ error: 'Failed to poll task queue' }, { status: 500 })
  }
}
