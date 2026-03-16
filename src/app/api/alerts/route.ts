import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { createAlertSchema, validateBody } from '@/lib/validation'
import { getPrismaClient } from '@/lib/prisma'

interface AlertRule {
  id: number
  name: string
  description: string | null
  enabled: number
  entity_type: string
  condition_field: string
  condition_operator: string
  condition_value: string
  action_type: string
  action_config: string
  cooldown_minutes: number
  last_triggered_at: number | null
  trigger_count: number
  created_by: string
  created_at: number
  updated_at: number
}

/**
 * GET /api/alerts - List all alert rules
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const prisma = getPrismaClient()
  const workspaceId = auth.user.workspace_id ?? 1
  try {
    const rules = (await prisma.alert_rules.findMany({
      where: { workspace_id: workspaceId },
      orderBy: { created_at: 'desc' },
    })) as unknown as AlertRule[]
    return NextResponse.json({ rules })
  } catch {
    return NextResponse.json({ rules: [] })
  }
}

/**
 * POST /api/alerts - Create a new alert rule or evaluate rules
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const prisma = getPrismaClient()
  const workspaceId = auth.user.workspace_id ?? 1

  // Check for evaluate action first (peek at body without consuming)
  let rawBody: any
  try { rawBody = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (rawBody.action === 'evaluate') {
    return evaluateRules(prisma, workspaceId)
  }

  // Validate for create using schema
  const parseResult = createAlertSchema.safeParse(rawBody)
  if (!parseResult.success) {
    const messages = parseResult.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`)
    return NextResponse.json({ error: 'Validation failed', details: messages }, { status: 400 })
  }

  // Create new rule
  const { name, description, entity_type, condition_field, condition_operator, condition_value, action_type, action_config, cooldown_minutes } = parseResult.data

  try {
    const now = Math.floor(Date.now() / 1000)
    const created = (await prisma.alert_rules.create({
      data: {
        name,
        description: description || null,
        entity_type,
        condition_field,
        condition_operator,
        condition_value,
        action_type: action_type || 'notification',
        action_config: JSON.stringify(action_config || {}),
        cooldown_minutes: cooldown_minutes || 60,
        created_by: auth.user?.username || 'system',
        workspace_id: workspaceId,
        created_at: now,
        updated_at: now,
      } as any,
    })) as unknown as AlertRule

    // Audit log
    try {
      await prisma.audit_log.create({
        data: {
          action: 'alert_rule_created',
          actor: auth.user?.username || 'system',
          detail: `Created alert rule: ${name}`,
          created_at: now,
        } as any,
        select: { id: true },
      })
    } catch { /* audit table might not exist */ }

    return NextResponse.json({ rule: created }, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to create rule' }, { status: 500 })
  }
}

/**
 * PUT /api/alerts - Update an alert rule
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const prisma = getPrismaClient()
  const workspaceId = auth.user.workspace_id ?? 1
  const body = await request.json()
  const { id, ...updates } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const existing = await prisma.alert_rules.findFirst({ where: { id: Number(id), workspace_id: workspaceId } })
  if (!existing) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })

  const allowed = ['name', 'description', 'enabled', 'entity_type', 'condition_field', 'condition_operator', 'condition_value', 'action_type', 'action_config', 'cooldown_minutes']
  const data: any = {}

  for (const key of allowed) {
    if (key in updates) {
      data[key] = key === 'action_config' ? JSON.stringify(updates[key]) : updates[key]
    }
  }

  if (Object.keys(data).length === 0) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  data.updated_at = Math.floor(Date.now() / 1000)

  await prisma.alert_rules.updateMany({ where: { id: Number(id), workspace_id: workspaceId }, data })
  const updated = await prisma.alert_rules.findFirst({ where: { id: Number(id), workspace_id: workspaceId } })
  return NextResponse.json({ rule: updated })
}

/**
 * DELETE /api/alerts - Delete an alert rule
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const prisma = getPrismaClient()
  const workspaceId = auth.user.workspace_id ?? 1
  const body = await request.json()
  const { id } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const result = await prisma.alert_rules.deleteMany({ where: { id: Number(id), workspace_id: workspaceId } })

  try {
    await prisma.audit_log.create({
      data: {
        action: 'alert_rule_deleted',
        actor: auth.user?.username || 'system',
        detail: `Deleted alert rule #${id}`,
        created_at: Math.floor(Date.now() / 1000),
      } as any,
      select: { id: true },
    })
  } catch { /* audit table might not exist */ }

  return NextResponse.json({ deleted: result.count > 0 })
}

/**
 * Evaluate all enabled alert rules against current data
 */
async function evaluateRules(prisma: ReturnType<typeof getPrismaClient>, workspaceId: number) {
  let rules: AlertRule[]
  try {
    rules = (await prisma.alert_rules.findMany({
      where: { enabled: 1, workspace_id: workspaceId },
    })) as unknown as AlertRule[]
  } catch {
    return NextResponse.json({ evaluated: 0, triggered: 0, results: [] })
  }

  const now = Math.floor(Date.now() / 1000)
  const results: { rule_id: number; rule_name: string; triggered: boolean; reason?: string }[] = []

  for (const rule of rules) {
    // Check cooldown
    if (rule.last_triggered_at && (now - rule.last_triggered_at) < rule.cooldown_minutes * 60) {
      results.push({ rule_id: rule.id, rule_name: rule.name, triggered: false, reason: 'In cooldown' })
      continue
    }

    const triggered = await evaluateRule(prisma, rule, now, workspaceId)
    results.push({ rule_id: rule.id, rule_name: rule.name, triggered, reason: triggered ? 'Condition met' : 'Condition not met' })

    if (triggered) {
      // Update trigger tracking
      await prisma.alert_rules.updateMany({
        where: { id: rule.id, workspace_id: workspaceId },
        data: { last_triggered_at: now, trigger_count: { increment: 1 } } as any,
      })

      // Create notification
      try {
        const config = JSON.parse(rule.action_config || '{}')
        const recipient = config.recipient || 'system'
        await prisma.notifications.create({
          data: {
            recipient,
            type: 'alert',
            title: `Alert: ${rule.name}`,
            message: rule.description || `Rule "${rule.name}" triggered`,
            source_type: 'alert_rule',
            source_id: rule.id,
            workspace_id: workspaceId,
            created_at: now,
          } as any,
          select: { id: true },
        })
      } catch { /* notification creation failed */ }
    }
  }

  const triggered = results.filter(r => r.triggered).length
  return NextResponse.json({ evaluated: rules.length, triggered, results })
}

async function evaluateRule(prisma: ReturnType<typeof getPrismaClient>, rule: AlertRule, now: number, workspaceId: number): Promise<boolean> {
  try {
    switch (rule.entity_type) {
      case 'agent': return evaluateAgentRule(prisma, rule, now, workspaceId)
      case 'task': return evaluateTaskRule(prisma, rule, now, workspaceId)
      case 'session': return evaluateSessionRule(prisma, rule, now, workspaceId)
      case 'activity': return evaluateActivityRule(prisma, rule, now, workspaceId)
      default: return false
    }
  } catch {
    return false
  }
}

const NUMERIC_FIELDS: Record<string, Set<string>> = {
  agents: new Set(['id', 'last_seen']),
  tasks: new Set(['id']),
  activities: new Set(['id']),
}

function coerceConditionValue(table: string, column: string, value: string): string | number {
  if (NUMERIC_FIELDS[table]?.has(column)) {
    const n = parseInt(value)
    return Number.isNaN(n) ? 0 : n
  }
  return value
}

async function evaluateAgentRule(prisma: ReturnType<typeof getPrismaClient>, rule: AlertRule, now: number, workspaceId: number): Promise<boolean> {
  const { condition_field, condition_operator, condition_value } = rule
  const field = safeColumn('agents', condition_field)

  if (condition_operator === 'count_above' || condition_operator === 'count_below') {
    const count = await prisma.agents.count({
      where: { workspace_id: workspaceId, [field]: coerceConditionValue('agents', field, condition_value) } as any,
    })
    return condition_operator === 'count_above' ? count > parseInt(condition_value) : count < parseInt(condition_value)
  }

  if (condition_operator === 'age_minutes_above') {
    // Check agents where field value is older than N minutes (e.g., last_seen)
    const minutes = parseInt(condition_value)
    if (!Number.isFinite(minutes)) return false
    const threshold = now - minutes * 60
    const count = await prisma.agents.count({
      where: {
        workspace_id: workspaceId,
        status: { not: 'offline' },
        [field]: { lt: threshold },
      } as any,
    })
    return count > 0
  }

  const agents = await prisma.agents.findMany({
    where: { workspace_id: workspaceId, status: { not: 'offline' } } as any,
    select: { [field]: true } as any,
  })
  return agents.some((a: any) => compareValue(a[field], condition_operator, condition_value))
}

async function evaluateTaskRule(prisma: ReturnType<typeof getPrismaClient>, rule: AlertRule, _now: number, workspaceId: number): Promise<boolean> {
  const { condition_field, condition_operator, condition_value } = rule
  const field = safeColumn('tasks', condition_field)

  if (condition_operator === 'count_above') {
    const count = await prisma.tasks.count({
      where: { workspace_id: workspaceId, [field]: coerceConditionValue('tasks', field, condition_value) } as any,
    })
    return count > parseInt(condition_value)
  }

  if (condition_operator === 'count_below') {
    const count = await prisma.tasks.count({ where: { workspace_id: workspaceId } as any })
    return count < parseInt(condition_value)
  }

  const tasks = await prisma.tasks.findMany({
    where: { workspace_id: workspaceId } as any,
    select: { [field]: true } as any,
  })
  return tasks.some((t: any) => compareValue(t[field], condition_operator, condition_value))
}

async function evaluateSessionRule(prisma: ReturnType<typeof getPrismaClient>, rule: AlertRule, _now: number, workspaceId: number): Promise<boolean> {
  // Session data comes from the gateway, not the DB, so we check the agents table for session info
  const { condition_operator, condition_value } = rule

  if (condition_operator === 'count_above') {
    const count = await prisma.agents.count({ where: { workspace_id: workspaceId, status: 'busy' } as any })
    return count > parseInt(condition_value)
  }

  return false
}

async function evaluateActivityRule(prisma: ReturnType<typeof getPrismaClient>, rule: AlertRule, now: number, workspaceId: number): Promise<boolean> {
  const { condition_field, condition_operator, condition_value } = rule
  const field = safeColumn('activities', condition_field)

  if (condition_operator === 'count_above') {
    // Count activities in the last hour
    const hourAgo = now - 3600
    const count = await prisma.activities.count({
      where: {
        workspace_id: workspaceId,
        created_at: { gt: hourAgo },
        [field]: coerceConditionValue('activities', field, condition_value),
      } as any,
    })
    return count > parseInt(condition_value)
  }

  return false
}

function compareValue(actual: any, operator: string, expected: string): boolean {
  if (actual == null) return false
  const strActual = String(actual)
  switch (operator) {
    case 'equals': return strActual === expected
    case 'not_equals': return strActual !== expected
    case 'greater_than': return Number(actual) > Number(expected)
    case 'less_than': return Number(actual) < Number(expected)
    case 'contains': return strActual.toLowerCase().includes(expected.toLowerCase())
    default: return false
  }
}

// Whitelist of columns per table to prevent SQL injection
const SAFE_COLUMNS: Record<string, Set<string>> = {
  agents: new Set(['status', 'role', 'name', 'last_seen', 'last_activity']),
  tasks: new Set(['status', 'priority', 'assigned_to', 'title']),
  activities: new Set(['type', 'actor', 'entity_type']),
}

function safeColumn(table: string, column: string): string {
  if (SAFE_COLUMNS[table]?.has(column)) return column
  return 'id' // fallback to safe column
}
