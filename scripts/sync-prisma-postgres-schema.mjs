import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const sqliteSchemaPath = path.join(root, 'prisma', 'schema.sqlite.prisma')
const postgresSchemaPath = path.join(root, 'prisma', 'schema.postgres.prisma')

function normalizeSharedSchema(schema) {
  return schema
    .replace('model settings {\n  key         String? @id', 'model settings {\n  key         String  @id')
    .replace('\n\n  @@index([category], map: "idx_settings_category")\n  @@ignore\n}', '\n\n  @@index([category], map: "idx_settings_category")\n}')
    .replace('model standup_reports {\n  date         String? @id', 'model standup_reports {\n  date         String  @id')
    .replace('\n\n  @@index([workspace_id], map: "idx_standup_reports_workspace_id")\n  @@index([created_at], map: "idx_standup_reports_created_at")\n  @@ignore\n}', '\n\n  @@index([workspace_id], map: "idx_standup_reports_workspace_id")\n  @@index([created_at], map: "idx_standup_reports_created_at")\n}')
    .replace('model schema_migrations {\n  id         String? @id', 'model schema_migrations {\n  id         String @id')
    .replace('\n\n  @@unique([workspace_id, github_repo, github_issue_number], map: "idx_tasks_github_issue", where: raw("NDEX idx_tasks_github_issue\\n          ON tasks(workspace_id, github_repo, github_issue_number)\\n          WHERE github_issue_number IS NOT NULL"))', '\n\n  @@unique([workspace_id, github_repo, github_issue_number], map: "idx_tasks_github_issue")')
    .replace('\n  @@index([workspace_id], map: "idx_tasks_recurring", where: raw("idx_tasks_recurring\\n        ON tasks(workspace_id)\\n        WHERE json_extract(metadata, \'$.recurrence.enabled\') = 1"))', '\n  @@index([workspace_id], map: "idx_tasks_recurring")')
}

const sqliteSchema = normalizeSharedSchema(readFileSync(sqliteSchemaPath, 'utf8'))

const postgresSchema = sqliteSchema
  .replace('output          = "../src/generated/prisma/sqlite"', 'output          = "../src/generated/prisma/postgres"')
  .replace('provider = "sqlite"', 'provider = "postgresql"')
  .replaceAll('@default(dbgenerated("unixepoch()"))', '@default(dbgenerated("floor(extract(epoch from now()))"))')
  .replaceAll('@default("datetime(\'now\')")', '@default(dbgenerated("CURRENT_TIMESTAMP::text"))')

writeFileSync(sqliteSchemaPath, sqliteSchema)
writeFileSync(postgresSchemaPath, postgresSchema)
