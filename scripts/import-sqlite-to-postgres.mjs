import crypto from 'node:crypto'
import process from 'node:process'
import { PrismaPg } from '@prisma/adapter-pg'
import Database from 'better-sqlite3'
import { PrismaClient as PrismaPostgresClient } from '../src/generated/prisma/postgres/index.js'

const sqlitePath = process.env.MISSION_CONTROL_DB_PATH || '.data/mission-control.db'
const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  console.error('DATABASE_URL is required for sqlite-to-postgres import')
  process.exit(1)
}

const TABLE_ORDER = [
  'workspaces',
  'users',
  'tasks',
  'agents',
  'comments',
  'activities',
  'notifications',
  'task_subscriptions',
  'standup_reports',
  'quality_reviews',
  'gateway_health_logs',
  'messages',
  'user_sessions',
  'workflow_templates',
  'audit_log',
  'webhooks',
  'webhook_deliveries',
  'workflow_pipelines',
  'pipeline_runs',
  'settings',
  'alert_rules',
  'tenants',
  'provision_jobs',
  'provision_events',
  'access_requests',
  'direct_connections',
  'github_syncs',
  'token_usage',
  'claude_sessions',
  'projects',
  'project_agent_assignments',
  'adapter_configs',
  'skills',
  'api_keys',
  'security_events',
  'agent_trust_scores',
  'mcp_call_log',
  'eval_runs',
  'eval_golden_sets',
  'eval_traces',
  'agent_api_keys',
  'gateways',
  'schema_migrations',
]

const CRITICAL_TABLES = [
  'users',
  'workspaces',
  'projects',
  'tasks',
  'comments',
  'messages',
  'notifications',
  'settings',
  'webhooks',
  'pipeline_runs',
  'token_usage',
  'skills',
  'agents',
]

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

function getOrderBy(columns) {
  if (columns.includes('id')) return ' ORDER BY id ASC'
  if (columns.includes('key')) return ' ORDER BY key ASC'
  if (columns.includes('date')) return ' ORDER BY date ASC'
  return ''
}

function hashRows(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true })
const pg = new PrismaPostgresClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
})

async function main() {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name)
  const orderedTables = TABLE_ORDER.filter((name) => tables.includes(name))

  if (orderedTables.length === 0) {
    throw new Error('No SQLite tables discovered for import')
  }

  console.log(`Importing ${orderedTables.length} tables from ${sqlitePath}`)

  await pg.$executeRawUnsafe(`TRUNCATE TABLE ${orderedTables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`)

  const parity = []

  for (const table of orderedTables) {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
    const rows = sqlite.prepare(`SELECT * FROM ${quoteIdent(table)}${getOrderBy(columns)}`).all()

    for (const row of rows) {
      const values = columns.map((column) => row[column])
      const placeholders = values.map((_, index) => `$${index + 1}`).join(', ')
      const insertSql = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${placeholders})`
      await pg.$executeRawUnsafe(insertSql, ...values)
    }

    if (columns.includes('id')) {
      await pg.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence(${`'${table}'`}, 'id'), COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 1), COALESCE((SELECT MAX(id) IS NOT NULL FROM ${quoteIdent(table)}), false))`
      )
    }

    const sqliteCount = rows.length
    const postgresCountRow = await pg.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM ${quoteIdent(table)}`)
    const postgresCount = postgresCountRow[0]?.count ?? 0

    const summary = {
      table,
      sqliteCount,
      postgresCount,
    }

    if (CRITICAL_TABLES.includes(table)) {
      const postgresRows = await pg.$queryRawUnsafe(`SELECT * FROM ${quoteIdent(table)}${getOrderBy(columns)}`)
      summary.sqliteHash = hashRows(rows)
      summary.postgresHash = hashRows(postgresRows)
      summary.hashMatch = summary.sqliteHash === summary.postgresHash
    }

    parity.push(summary)
    console.log(JSON.stringify(summary))
  }

  const failures = parity.filter((entry) => entry.sqliteCount !== entry.postgresCount || entry.hashMatch === false)
  if (failures.length > 0) {
    console.error('Parity check failed')
    console.error(JSON.stringify(failures, null, 2))
    process.exitCode = 1
    return
  }

  console.log('SQLite to Postgres import completed successfully')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    sqlite.close()
    await pg.$disconnect()
  })
