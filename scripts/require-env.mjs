function usage() {
  console.error('Usage: node scripts/require-env.mjs <ENV_VAR_NAME>')
  process.exit(2)
}

const name = process.argv[2]
if (!name) usage()

const value = process.env[name]
if (typeof value === 'string' && value.trim()) {
  process.exit(0)
}

console.error(`${name} is required.`)
if (name === 'DATABASE_URL') {
  console.error("If you started Postgres via docker-compose.postgres.yml locally, use:")
  console.error("  DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/mission_control'")
}
process.exit(1)

