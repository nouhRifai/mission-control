import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.postgres.prisma',
  migrations: {
    path: 'prisma/migrations/postgres',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
})
