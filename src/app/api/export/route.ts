import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/db'
import { heavyLimiter } from '@/lib/rate-limit'
import { getPrismaClient } from '@/lib/prisma'

/**
 * GET /api/export?type=audit|tasks|activities|pipelines&format=csv|json&since=UNIX&until=UNIX
 * Admin-only data export endpoint.
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = heavyLimiter(request)
  if (rateCheck) return rateCheck

  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type')
  const format = searchParams.get('format') || 'csv'
  const since = searchParams.get('since')
  const until = searchParams.get('until')

  if (!type || !['audit', 'tasks', 'activities', 'pipelines'].includes(type)) {
    return NextResponse.json(
      { error: 'type required: audit, tasks, activities, pipelines' },
      { status: 400 }
    )
  }

  const prisma = getPrismaClient()
  const workspaceId = auth.user.workspace_id ?? 1
  const createdAtWhere: any = {}

  if (since) {
    const sinceNum = parseInt(since)
    if (Number.isFinite(sinceNum)) createdAtWhere.gte = sinceNum
  }
  if (until) {
    const untilNum = parseInt(until)
    if (Number.isFinite(untilNum)) createdAtWhere.lte = untilNum
  }

  const requestedLimit = parseInt(searchParams.get('limit') || '10000')
  const maxLimit = 50000
  const limit = Math.min(requestedLimit, maxLimit)

  let rows: any[] = []
  let headers: string[] = []
  let filename = ''

  switch (type) {
    case 'audit': {
      // audit_log is instance-global (no workspace_id column); export is admin-only so this is safe
      rows = await prisma.audit_log.findMany({
        where: Object.keys(createdAtWhere).length ? { created_at: createdAtWhere } : undefined,
        orderBy: { created_at: 'desc' },
        take: limit,
      })
      headers = ['id', 'action', 'actor', 'actor_id', 'target_type', 'target_id', 'detail', 'ip_address', 'user_agent', 'created_at']
      filename = 'audit-log'
      break
    }
    case 'tasks': {
      const where: any = { workspace_id: workspaceId }
      if (Object.keys(createdAtWhere).length) where.created_at = createdAtWhere
      rows = await prisma.tasks.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
      })
      headers = ['id', 'title', 'description', 'status', 'priority', 'assigned_to', 'created_by', 'created_at', 'updated_at', 'due_date', 'estimated_hours', 'actual_hours', 'tags']
      filename = 'tasks'
      break
    }
    case 'activities': {
      const where: any = { workspace_id: workspaceId }
      if (Object.keys(createdAtWhere).length) where.created_at = createdAtWhere
      rows = await prisma.activities.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
      })
      headers = ['id', 'type', 'entity_type', 'entity_id', 'actor', 'description', 'data', 'created_at']
      filename = 'activities'
      break
    }
    case 'pipelines': {
      const where: any = { workspace_id: workspaceId }
      if (Object.keys(createdAtWhere).length) where.created_at = createdAtWhere
      const pipelineRuns = await prisma.pipeline_runs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        include: { workflow_pipelines: { select: { name: true } } },
      })
      rows = (pipelineRuns as any[]).map((run) => ({
        ...run,
        pipeline_name: run.workflow_pipelines?.name ?? null,
      }))
      headers = ['id', 'pipeline_id', 'pipeline_name', 'status', 'current_step', 'steps_snapshot', 'started_at', 'completed_at', 'triggered_by', 'created_at']
      filename = 'pipeline-runs'
      break
    }
  }

  // Log the export
  const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
  logAuditEvent({
    action: 'data_export',
    actor: auth.user.username,
    actor_id: auth.user.id,
    detail: { type, format, row_count: rows.length },
    ip_address: ipAddress,
  })

  const dateStr = new Date().toISOString().split('T')[0]

  if (format === 'csv') {
    const csvRows = [headers.join(',')]
    for (const row of rows) {
      const values = headers.map(h => {
        const val = row[h]
        if (val == null) return ''
        const str = String(val)
        // Escape CSV: wrap in quotes if contains comma, newline, or quote
        if (str.includes(',') || str.includes('\n') || str.includes('"')) {
          return `"${str.replace(/"/g, '""')}"`
        }
        return str
      })
      csvRows.push(values.join(','))
    }

    return new NextResponse(csvRows.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename=${filename}-${dateStr}.csv`,
      },
    })
  }

  // JSON format
  return NextResponse.json(
    { type, exported_at: new Date().toISOString(), count: rows.length, data: rows },
    {
      headers: {
        'Content-Disposition': `attachment; filename=${filename}-${dateStr}.json`,
      },
    }
  )
}
