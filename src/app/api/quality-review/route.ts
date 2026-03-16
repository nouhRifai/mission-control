import { NextRequest, NextResponse } from 'next/server'
import { db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { validateBody, qualityReviewSchema } from '@/lib/validation'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { eventBus } from '@/lib/event-bus'
import { getPrismaClient } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient()
    const { searchParams } = new URL(request.url)
    const workspaceId = auth.user.workspace_id ?? 1;
    const taskIdsParam = searchParams.get('taskIds')
    const taskId = parseInt(searchParams.get('taskId') || '')

    if (taskIdsParam) {
      const ids = taskIdsParam
        .split(',')
        .map((id) => parseInt(id.trim()))
        .filter((id) => !Number.isNaN(id))

      if (ids.length === 0) {
        return NextResponse.json({ error: 'taskIds must include at least one numeric id' }, { status: 400 })
      }

      const rows = await prisma.quality_reviews.findMany({
        where: { task_id: { in: ids }, workspace_id: workspaceId },
        orderBy: [{ task_id: 'asc' }, { created_at: 'desc' }],
      }) as unknown as Array<{ task_id: number; reviewer?: string; status?: string; created_at?: number }>

      const byTask: Record<number, { status?: string; reviewer?: string; created_at?: number } | null> = {}
      for (const id of ids) {
        byTask[id] = null
      }

      for (const row of rows) {
        const existing = byTask[row.task_id]
        if (!existing || (row.created_at || 0) > (existing.created_at || 0)) {
          byTask[row.task_id] = { status: row.status, reviewer: row.reviewer, created_at: row.created_at }
        }
      }

      return NextResponse.json({ latest: byTask })
    }

    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
    }

    const reviews = await prisma.quality_reviews.findMany({
      where: { task_id: taskId, workspace_id: workspaceId },
      orderBy: { created_at: 'desc' },
      take: 10,
    })

    return NextResponse.json({ reviews })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/quality-review error')
    return NextResponse.json({ error: 'Failed to fetch quality reviews' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const validated = await validateBody(request, qualityReviewSchema)
    if ('error' in validated) return validated.error
    const { taskId, reviewer, status, notes } = validated.data

    const prisma = getPrismaClient()
    const workspaceId = auth.user.workspace_id ?? 1;
    const now = Math.floor(Date.now() / 1000)

    const task = await prisma.tasks.findFirst({
      where: { id: taskId, workspace_id: workspaceId },
      select: { id: true, title: true },
    }) as any
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const result = await prisma.quality_reviews.create({
      data: {
        task_id: taskId,
        reviewer,
        status,
        notes,
        workspace_id: workspaceId,
        created_at: now,
      } as any,
      select: { id: true },
    })

    db_helpers.logActivity(
      'quality_review',
      'task',
      taskId,
      reviewer,
      `Quality review ${status} for task: ${task.title}`,
      { status, notes },
      workspaceId
    )

    // Auto-advance task based on review outcome
    if (status === 'approved') {
      await prisma.tasks.updateMany({
        where: { id: taskId, workspace_id: workspaceId },
        data: { status: 'done', updated_at: now } as any,
      })
      eventBus.broadcast('task.status_changed', {
        id: taskId,
        status: 'done',
        previous_status: 'review',
        updated_at: Math.floor(Date.now() / 1000),
      })
    } else if (status === 'rejected') {
      // Rejected: push back to in_progress with the rejection notes as error_message
      await prisma.tasks.updateMany({
        where: { id: taskId, workspace_id: workspaceId },
        data: {
          status: 'in_progress',
          error_message: `Quality review rejected by ${reviewer}: ${notes}`,
          updated_at: now,
        } as any,
      })
      eventBus.broadcast('task.status_changed', {
        id: taskId,
        status: 'in_progress',
        previous_status: 'review',
        updated_at: Math.floor(Date.now() / 1000),
      })
    }

    return NextResponse.json({ success: true, id: result.id })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/quality-review error')
    return NextResponse.json({ error: 'Failed to create quality review' }, { status: 500 })
  }
}
