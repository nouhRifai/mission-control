import { describe, expect, it, vi } from 'vitest'

async function loadProviderWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules()

  const originalProvider = process.env.MISSION_CONTROL_DB_PROVIDER

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  const mod = await import('./database-provider')

  if (originalProvider === undefined) delete process.env.MISSION_CONTROL_DB_PROVIDER
  else process.env.MISSION_CONTROL_DB_PROVIDER = originalProvider

  // Clear module cache so other tests don't inherit the env-shaped import state.
  vi.resetModules()

  return mod
}

describe('database provider helpers', () => {
  it('defaults backup extension to sqlite db files', async () => {
    const mod = await loadProviderWithEnv({ MISSION_CONTROL_DB_PROVIDER: undefined })
    expect(mod.getDatabaseProviderLabel()).toBe('sqlite')
    expect(mod.getDatabaseBackupExtension()).toBe('.db')
    expect(mod.usesFileDatabase()).toBe(true)
  })

  it('switches backup extension for postgres mode', async () => {
    const mod = await loadProviderWithEnv({ MISSION_CONTROL_DB_PROVIDER: 'postgres' })
    expect(mod.getDatabaseProviderLabel()).toBe('postgres')
    expect(mod.getDatabaseBackupExtension()).toBe('.sql')
    expect(mod.usesFileDatabase()).toBe(false)
  })
})
