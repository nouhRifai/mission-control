Postgres baseline migrations are generated from `prisma/schema.postgres.prisma`.

The initial baseline is checked in at `prisma/migrations/postgres/0001_baseline/migration.sql`.

If you need to regenerate it from the current Prisma schema:

```bash
pnpm exec prisma migrate diff \
  --from-empty \
  --to-schema prisma/schema.postgres.prisma \
  --script
```

and save the output to:

`prisma/migrations/postgres/0001_baseline/migration.sql`

To apply migrations to a Postgres database:

```bash
MISSION_CONTROL_DB_PROVIDER=postgres DATABASE_URL='postgresql://...' pnpm db:migrate:postgres
```
