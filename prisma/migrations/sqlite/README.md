SQLite baseline migrations are generated from `prisma/schema.sqlite.prisma`.

The initial baseline is checked in at `prisma/migrations/sqlite/0001_baseline/migration.sql`.

Note: Mission Control currently bootstraps SQLite via the legacy migration system in
`src/lib/migrations.ts`. During the rollout, SQLite remains supported through Prisma,
but Prisma Migrate should not be applied to an existing SQLite DB unless you first
mark the baseline as applied (e.g. via `prisma migrate resolve`).

To apply Prisma migrations to a new SQLite database:

```bash
MISSION_CONTROL_DB_PROVIDER=sqlite pnpm db:migrate:sqlite
```

