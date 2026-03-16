import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/db'
import { config } from '@/lib/config'
import { mutationLimiter } from '@/lib/rate-limit'
import { validateBody, updateSettingsSchema } from '@/lib/validation'
import { getPrismaClient } from '@/lib/prisma'

interface SettingRow {
  key: string
  value: string
  description: string | null
  category: string
  updated_by: string | null
  updated_at: number
}

// Default settings definitions (category, description, default value)
const settingDefinitions: Record<string, { category: string; description: string; default: string }> = {
  // Retention
  'retention.activities_days': { category: 'retention', description: 'Days to keep activity records', default: String(config.retention.activities) },
  'retention.audit_log_days': { category: 'retention', description: 'Days to keep audit log entries', default: String(config.retention.auditLog) },
  'retention.logs_days': { category: 'retention', description: 'Days to keep log files', default: String(config.retention.logs) },
  'retention.notifications_days': { category: 'retention', description: 'Days to keep notifications', default: String(config.retention.notifications) },
  'retention.pipeline_runs_days': { category: 'retention', description: 'Days to keep pipeline run history', default: String(config.retention.pipelineRuns) },
  'retention.token_usage_days': { category: 'retention', description: 'Days to keep token usage data', default: String(config.retention.tokenUsage) },
  'retention.gateway_sessions_days': { category: 'retention', description: 'Days to keep inactive gateway session metadata', default: String(config.retention.gatewaySessions) },

  // Gateway
  'gateway.host': { category: 'gateway', description: 'Gateway hostname', default: config.gatewayHost },
  'gateway.port': { category: 'gateway', description: 'Gateway port number', default: String(config.gatewayPort) },

  // Chat
  'chat.coordinator_target_agent': {
    category: 'chat',
    description: 'Optional coordinator routing target (agent name or openclawId). When set, coordinator inbox messages are forwarded to this agent before default/main-session fallback.',
    default: '',
  },

  // General
  'general.site_name': { category: 'general', description: 'Mission Control display name', default: 'Mission Control' },
  'general.auto_cleanup': { category: 'general', description: 'Enable automatic data cleanup', default: 'false' },
  'general.auto_backup': { category: 'general', description: 'Enable automatic daily backups', default: 'false' },
  'general.backup_retention_count': { category: 'general', description: 'Number of backup files to keep', default: '10' },

  // Subscription overrides
  'subscription.plan_override': { category: 'general', description: 'Override auto-detected subscription plan (e.g. max, max_5x, pro)', default: '' },
  'subscription.codex_plan': { category: 'general', description: 'Codex/OpenAI subscription plan (e.g. chatgpt, plus, pro)', default: '' },

  // Interface
  'general.interface_mode': { category: 'general', description: 'Interface complexity (essential or full)', default: 'essential' },

  // Onboarding
  'onboarding.completed': { category: 'onboarding', description: 'Whether onboarding has been completed', default: 'false' },
  'onboarding.completed_at': { category: 'onboarding', description: 'Timestamp when onboarding was completed', default: '' },
  'onboarding.skipped': { category: 'onboarding', description: 'Whether onboarding was skipped', default: 'false' },
  'onboarding.completed_steps': { category: 'onboarding', description: 'JSON array of completed step IDs', default: '[]' },
  'onboarding.checklist_dismissed': { category: 'onboarding', description: 'Whether the onboarding checklist has been dismissed', default: 'false' },
}

/**
 * GET /api/settings - List all settings (grouped by category)
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const prisma = getPrismaClient()
  const rows = await prisma.settings.findMany({
    orderBy: [{ category: 'asc' }, { key: 'asc' }],
  }) as unknown as SettingRow[]
  const stored = new Map(rows.map(r => [r.key, r]))

  // Merge defaults with stored values
  const settings: Array<{
    key: string
    value: string
    description: string
    category: string
    updated_by: string | null
    updated_at: number | null
    is_default: boolean
  }> = []

  for (const [key, def] of Object.entries(settingDefinitions)) {
    const row = stored.get(key)
    settings.push({
      key,
      value: row?.value ?? def.default,
      description: row?.description ?? def.description,
      category: row?.category ?? def.category,
      updated_by: row?.updated_by ?? null,
      updated_at: row?.updated_at ?? null,
      is_default: !row,
    })
  }

  // Also include any custom settings not in definitions
  for (const row of rows) {
    if (!settingDefinitions[row.key]) {
      settings.push({
        key: row.key,
        value: row.value,
        description: row.description ?? '',
        category: row.category,
        updated_by: row.updated_by,
        updated_at: row.updated_at,
        is_default: false,
      })
    }
  }

  // Group by category
  const grouped: Record<string, typeof settings> = {}
  for (const s of settings) {
    if (!grouped[s.category]) grouped[s.category] = []
    grouped[s.category].push(s)
  }

  return NextResponse.json({ settings, grouped })
}

/**
 * PUT /api/settings - Update one or more settings
 * Body: { settings: { key: value, ... } }
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const result = await validateBody(request, updateSettingsSchema)
  if ('error' in result) return result.error
  const body = result.data

  const prisma = getPrismaClient()
  const updated: string[] = []
  const changes: Record<string, { old: string | null; new: string }> = {}

  const now = Math.floor(Date.now() / 1000)
  const keys = Object.keys(body.settings)
  const existingRows = keys.length === 0
    ? []
    : await prisma.settings.findMany({
        where: { key: { in: keys } },
        select: { key: true, value: true },
      })
  const existingMap = new Map(existingRows.map((r) => [r.key, r.value]))

  await prisma.$transaction(async (tx) => {
    for (const [key, value] of Object.entries(body.settings)) {
      const strValue = String(value)
      const def = settingDefinitions[key]
      const category = def?.category ?? 'custom'
      const description = def?.description ?? null

      changes[key] = { old: existingMap.get(key) ?? null, new: strValue }

      await tx.settings.upsert({
        where: { key },
        create: {
          key,
          value: strValue,
          description,
          category,
          updated_by: auth.user.username,
          updated_at: now,
        },
        update: {
          value: strValue,
          updated_by: auth.user.username,
          updated_at: now,
        },
      })
      updated.push(key)
    }
  })

  // Audit log
  const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
  logAuditEvent({
    action: 'settings_update',
    actor: auth.user.username,
    actor_id: auth.user.id,
    detail: { updated_keys: updated, changes },
    ip_address: ipAddress,
  })

  return NextResponse.json({ updated, count: updated.length })
}

/**
 * DELETE /api/settings?key=... - Reset a setting to default
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Request body required' }, { status: 400 }) }
  const key = body.key

  if (!key) {
    return NextResponse.json({ error: 'key parameter required' }, { status: 400 })
  }

  const prisma = getPrismaClient()
  const existing = await prisma.settings.findUnique({ where: { key }, select: { value: true } })

  if (!existing) {
    return NextResponse.json({ error: 'Setting not found or already at default' }, { status: 404 })
  }

  await prisma.settings.delete({ where: { key }, select: { key: true } })

  const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
  logAuditEvent({
    action: 'settings_reset',
    actor: auth.user.username,
    actor_id: auth.user.id,
    detail: { key, old_value: existing.value },
    ip_address: ipAddress,
  })

  return NextResponse.json({ reset: key, default_value: settingDefinitions[key]?.default ?? null })
}
