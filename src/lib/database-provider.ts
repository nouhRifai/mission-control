import path from 'node:path'
import { config } from '@/lib/config'
import { isPostgresProvider } from '@/lib/prisma'

export function getDatabaseProviderLabel() {
  return isPostgresProvider() ? 'postgres' : 'sqlite'
}

export function usesFileDatabase() {
  return !isPostgresProvider()
}

export function getDatabaseBackupDir() {
  return path.join(path.dirname(config.dbPath), 'backups')
}

export function getDatabaseBackupExtension() {
  return usesFileDatabase() ? '.db' : '.sql'
}

export function getConfiguredDatabaseTarget() {
  return usesFileDatabase() ? config.dbPath : config.databaseUrl
}
