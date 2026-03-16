import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { config } from '@/lib/config'
import { runCommand } from '@/lib/command'
import { getDatabaseBackupDir, getDatabaseBackupExtension } from '@/lib/database-provider'
import { getPrismaClient, isPostgresProvider } from '@/lib/prisma'

export interface DatabaseBackupFile {
  name: string
  size: number
  created_at: number
}

export function listDatabaseBackups(): DatabaseBackupFile[] {
  const backupDir = getDatabaseBackupDir()
  const extension = getDatabaseBackupExtension()

  try {
    return readdirSync(backupDir)
      .filter((file) => file.endsWith(extension))
      .map((file) => {
        const stat = statSync(join(backupDir, file))
        return {
          name: file,
          size: stat.size,
          created_at: Math.floor(stat.mtimeMs / 1000),
        }
      })
      .sort((a, b) => b.created_at - a.created_at)
  } catch {
    return []
  }
}

export function getDatabaseSizeBytes() {
  if (isPostgresProvider()) return null

  try {
    return statSync(config.dbPath).size
  } catch {
    return 0
  }
}

export async function getDatabaseHealthSnapshot() {
  if (isPostgresProvider()) {
    const prisma = getPrismaClient()
    await prisma.$queryRawUnsafe('SELECT 1')
    return {
      provider: 'postgres',
      walMode: null,
      migrationVersion: null,
      sizeBytes: null,
      target: config.databaseUrl,
    }
  }

  return {
    provider: 'sqlite',
    walMode: true,
    migrationVersion: null,
    sizeBytes: getDatabaseSizeBytes(),
    target: config.dbPath,
  }
}

export async function createPostgresBackup(backupPath: string) {
  const connectionUrl = config.databaseUrl
  if (!connectionUrl) {
    throw new Error('DATABASE_URL is required for Postgres backups')
  }

  await runCommand('pg_dump', ['--file', backupPath, connectionUrl], {
    timeoutMs: 120000,
  })

  return statSync(backupPath)
}

export function getDatabaseBackupsRoot() {
  return join(dirname(config.dbPath), 'backups')
}
