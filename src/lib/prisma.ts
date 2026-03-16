import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient as PrismaSqliteClient } from '@/generated/prisma/sqlite'
import { PrismaClient as PrismaPostgresClient } from '@/generated/prisma/postgres'
import { config } from '@/lib/config'

export type MissionControlDbProvider = 'sqlite' | 'postgres'
// Both generated clients are expected to be schema-equivalent. We use the SQLite
// client type as the canonical compile-time surface to avoid union call-signature
// issues when selecting a provider at runtime.
export type MissionControlPrismaClient = PrismaSqliteClient

declare global {
  // eslint-disable-next-line no-var
  var __missionControlPrismaSqlite: PrismaSqliteClient | undefined
  // eslint-disable-next-line no-var
  var __missionControlPrismaPostgres: PrismaPostgresClient | undefined
}

function buildSqliteClient() {
  const adapter = new PrismaBetterSqlite3({
    url: config.dbPath,
  })

  return new PrismaSqliteClient({
    adapter,
  })
}

function buildPostgresClient() {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required when MISSION_CONTROL_DB_PROVIDER=postgres')
  }

  const adapter = new PrismaPg({
    connectionString: config.databaseUrl,
  })

  return new PrismaPostgresClient({
    adapter,
  })
}

export function getDbProvider(): MissionControlDbProvider {
  return config.dbProvider
}

export function isPostgresProvider(): boolean {
  return getDbProvider() === 'postgres'
}

export function getPrismaClient(): MissionControlPrismaClient {
  if (isPostgresProvider()) {
    if (!globalThis.__missionControlPrismaPostgres) {
      globalThis.__missionControlPrismaPostgres = buildPostgresClient()
    }
    return globalThis.__missionControlPrismaPostgres as unknown as MissionControlPrismaClient
  }

  if (!globalThis.__missionControlPrismaSqlite) {
    globalThis.__missionControlPrismaSqlite = buildSqliteClient()
  }
  return globalThis.__missionControlPrismaSqlite
}

export async function disconnectPrismaClients() {
  await Promise.allSettled([
    globalThis.__missionControlPrismaSqlite?.$disconnect(),
    globalThis.__missionControlPrismaPostgres?.$disconnect(),
  ])

  globalThis.__missionControlPrismaSqlite = undefined
  globalThis.__missionControlPrismaPostgres = undefined
}
