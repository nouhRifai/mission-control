import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.sqlite.prisma',
  migrations: {
    path: 'prisma/migrations/sqlite',
  },
  datasource: {
    url:
      process.env.PRISMA_SQLITE_DATABASE_URL ||
      process.env.DATABASE_URL ||
      `file:${process.env.MISSION_CONTROL_DB_PATH || './.data/mission-control.db'}`,
  },
})
