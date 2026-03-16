import '@testing-library/jest-dom'

// Most unit tests assume the legacy SQLite runtime is available. Individual tests that
// validate Postgres behavior should override env and use `vi.resetModules()`.
process.env.MISSION_CONTROL_DB_PROVIDER = 'sqlite'
