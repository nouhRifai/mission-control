/**
 * Recurring Task Spawner
 *
 * Queries task templates with recurrence metadata and spawns child tasks
 * when their cron schedule is due. Uses template-clone pattern:
 * the recurring task stays as a template, child tasks get spawned with
 * date-suffixed titles.
 */

import { db_helpers } from './db'
import { logger } from './logger'
import { isCronDue } from './schedule-parser'
import { getPrismaClient } from './prisma'

export interface RecurrenceMetadata {
  cron_expr: string
  natural_text: string
  enabled: boolean
  last_spawned_at: number | null
  spawn_count: number
  parent_task_id: null
}

function formatDateSuffix(): string {
  const now = new Date()
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[now.getMonth()]} ${String(now.getDate()).padStart(2, '0')}`
}

export async function spawnRecurringTasks(): Promise<{ ok: boolean; message: string }> {
  try {
    const prisma = getPrismaClient()
    const nowMs = Date.now()
    const nowSec = Math.floor(nowMs / 1000)

    // Find all template tasks with enabled recurrence (metadata JSON).
    // We avoid provider-specific JSON-path SQL by filtering + parsing in application code.
    const candidates = await prisma.tasks.findMany({
      where: {
        metadata: { not: null, contains: '"recurrence"' },
      },
      select: {
        id: true,
        title: true,
        description: true,
        priority: true,
        project_id: true,
        assigned_to: true,
        created_by: true,
        tags: true,
        metadata: true,
        workspace_id: true,
      },
    }) as any[]

    const templates = candidates.filter((row) => {
      try {
        const metadata = row.metadata ? JSON.parse(row.metadata) : {}
        const recurrence = metadata.recurrence as RecurrenceMetadata | undefined
        return Boolean(recurrence?.enabled && recurrence.cron_expr && recurrence.parent_task_id == null)
      } catch {
        return false
      }
    })

    if (templates.length === 0) {
      return { ok: true, message: 'No recurring tasks' }
    }

    let spawned = 0

    for (const template of templates) {
      const metadata = template.metadata ? JSON.parse(template.metadata) : {}
      const recurrence = metadata.recurrence as RecurrenceMetadata | undefined
      if (!recurrence?.cron_expr || !recurrence.enabled) continue

      const lastSpawnedAtMs = recurrence.last_spawned_at ? recurrence.last_spawned_at * 1000 : 0

      if (!isCronDue(recurrence.cron_expr, nowMs, lastSpawnedAtMs)) continue

      const dateSuffix = formatDateSuffix()
      const childTitle = `${template.title} - ${dateSuffix}`

      // Duplicate prevention: check if a child with this exact title already exists in the same project
      const existing = await prisma.tasks.findFirst({
        where: { title: childTitle, workspace_id: template.workspace_id, project_id: template.project_id },
        select: { id: true },
      })
      if (existing) continue

      // Spawn child task
      const childMetadata = {
        recurrence: {
          parent_task_id: template.id,
          spawned_from_cron: recurrence.cron_expr,
        },
      }

      const childId = await prisma.$transaction(async (tx) => {
        // Get project ticket number (if project-scoped).
        const ticketNo = template.project_id
          ? (await tx.projects.update({
              where: { id: template.project_id },
              data: { ticket_counter: { increment: 1 }, updated_at: nowSec },
              select: { ticket_counter: true },
            })).ticket_counter
          : null

        const created = await tx.tasks.create({
          data: {
            title: childTitle,
            description: template.description,
            status: template.assigned_to ? 'assigned' : 'inbox',
            priority: template.priority,
            project_id: template.project_id,
            project_ticket_no: ticketNo,
            assigned_to: template.assigned_to,
            created_by: 'scheduler',
            created_at: nowSec,
            updated_at: nowSec,
            tags: template.tags,
            metadata: JSON.stringify(childMetadata),
            workspace_id: template.workspace_id,
          },
          select: { id: true },
        })

        // Update template: bump spawn count and last_spawned_at.
        const updatedRecurrence = {
          ...recurrence,
          last_spawned_at: nowSec,
          spawn_count: (recurrence.spawn_count || 0) + 1,
        }
        const updatedMetadata = { ...metadata, recurrence: updatedRecurrence }
        await tx.tasks.update({
          where: { id: template.id },
          data: { metadata: JSON.stringify(updatedMetadata), updated_at: nowSec },
          select: { id: true },
        })

        return created.id
      })

      db_helpers.logActivity(
        'task_created',
        'task',
        childId,
        'scheduler',
        `Recurring task spawned: ${childTitle}`,
        { parent_task_id: template.id, cron_expr: recurrence.cron_expr },
        template.workspace_id,
      )

      spawned++
    }

    return { ok: true, message: spawned > 0 ? `Spawned ${spawned} recurring task(s)` : 'No tasks due' }
  } catch (err: any) {
    logger.error({ err }, 'Recurring task spawn failed')
    return { ok: false, message: `Recurring spawn failed: ${err.message}` }
  }
}
