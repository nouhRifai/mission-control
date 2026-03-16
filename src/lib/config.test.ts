import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadConfigWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules()

  const original = {
    MISSION_CONTROL_DATA_DIR: process.env.MISSION_CONTROL_DATA_DIR,
    MISSION_CONTROL_DB_PROVIDER: process.env.MISSION_CONTROL_DB_PROVIDER,
    MISSION_CONTROL_BUILD_DATA_DIR: process.env.MISSION_CONTROL_BUILD_DATA_DIR,
    MISSION_CONTROL_BUILD_DB_PATH: process.env.MISSION_CONTROL_BUILD_DB_PATH,
    MISSION_CONTROL_BUILD_TOKENS_PATH: process.env.MISSION_CONTROL_BUILD_TOKENS_PATH,
    DATABASE_URL: process.env.DATABASE_URL,
    MISSION_CONTROL_DB_PATH: process.env.MISSION_CONTROL_DB_PATH,
    MISSION_CONTROL_TOKENS_PATH: process.env.MISSION_CONTROL_TOKENS_PATH,
    NEXT_PHASE: process.env.NEXT_PHASE,
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  const mod = await import('./config')

  if (original.MISSION_CONTROL_DATA_DIR === undefined) delete process.env.MISSION_CONTROL_DATA_DIR
  else process.env.MISSION_CONTROL_DATA_DIR = original.MISSION_CONTROL_DATA_DIR

  if (original.MISSION_CONTROL_DB_PROVIDER === undefined) delete process.env.MISSION_CONTROL_DB_PROVIDER
  else process.env.MISSION_CONTROL_DB_PROVIDER = original.MISSION_CONTROL_DB_PROVIDER

  if (original.MISSION_CONTROL_BUILD_DATA_DIR === undefined) delete process.env.MISSION_CONTROL_BUILD_DATA_DIR
  else process.env.MISSION_CONTROL_BUILD_DATA_DIR = original.MISSION_CONTROL_BUILD_DATA_DIR

  if (original.MISSION_CONTROL_BUILD_DB_PATH === undefined) delete process.env.MISSION_CONTROL_BUILD_DB_PATH
  else process.env.MISSION_CONTROL_BUILD_DB_PATH = original.MISSION_CONTROL_BUILD_DB_PATH

  if (original.MISSION_CONTROL_BUILD_TOKENS_PATH === undefined) delete process.env.MISSION_CONTROL_BUILD_TOKENS_PATH
  else process.env.MISSION_CONTROL_BUILD_TOKENS_PATH = original.MISSION_CONTROL_BUILD_TOKENS_PATH

  if (original.DATABASE_URL === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = original.DATABASE_URL

  if (original.MISSION_CONTROL_DB_PATH === undefined) delete process.env.MISSION_CONTROL_DB_PATH
  else process.env.MISSION_CONTROL_DB_PATH = original.MISSION_CONTROL_DB_PATH

  if (original.MISSION_CONTROL_TOKENS_PATH === undefined) delete process.env.MISSION_CONTROL_TOKENS_PATH
  else process.env.MISSION_CONTROL_TOKENS_PATH = original.MISSION_CONTROL_TOKENS_PATH

  if (original.NEXT_PHASE === undefined) delete process.env.NEXT_PHASE
  else process.env.NEXT_PHASE = original.NEXT_PHASE

  // Avoid leaking env-shaped singletons (like `config`) into subsequent test files.
  vi.resetModules()

  return mod.config
}

describe('config data paths', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('derives db and token paths from MISSION_CONTROL_DATA_DIR', async () => {
    const config = await loadConfigWithEnv({
      MISSION_CONTROL_DATA_DIR: '/tmp/mission-control-data',
      MISSION_CONTROL_DB_PATH: undefined,
      MISSION_CONTROL_TOKENS_PATH: undefined,
    })

    expect(config.dataDir).toBe('/tmp/mission-control-data')
    expect(config.dbProvider).toBe('sqlite')
    expect(config.databaseUrl).toBe('file:/tmp/mission-control-data/mission-control.db')
    expect(config.dbPath).toBe('/tmp/mission-control-data/mission-control.db')
    expect(config.tokensPath).toBe('/tmp/mission-control-data/mission-control-tokens.json')
  })

  it('respects explicit db and token path overrides', async () => {
    const config = await loadConfigWithEnv({
      MISSION_CONTROL_DATA_DIR: '/tmp/mission-control-data',
      MISSION_CONTROL_DB_PATH: '/tmp/custom.db',
      MISSION_CONTROL_TOKENS_PATH: '/tmp/custom-tokens.json',
    })

    expect(config.dataDir).toBe('/tmp/mission-control-data')
    expect(config.databaseUrl).toBe('file:/tmp/custom.db')
    expect(config.dbPath).toBe('/tmp/custom.db')
    expect(config.tokensPath).toBe('/tmp/custom-tokens.json')
  })

  it('uses a build-scoped worker data dir during next build', async () => {
    const config = await loadConfigWithEnv({
      NEXT_PHASE: 'phase-production-build',
      MISSION_CONTROL_DATA_DIR: '/tmp/runtime-data',
      MISSION_CONTROL_BUILD_DATA_DIR: '/tmp/build-scratch',
      MISSION_CONTROL_DB_PATH: undefined,
      MISSION_CONTROL_TOKENS_PATH: undefined,
    })

    expect(config.dataDir).toMatch(/^\/tmp\/build-scratch\/worker-\d+$/)
    expect(config.databaseUrl).toMatch(/^file:\/tmp\/build-scratch\/worker-\d+\/mission-control\.db$/)
    expect(config.dbPath).toMatch(/^\/tmp\/build-scratch\/worker-\d+\/mission-control\.db$/)
    expect(config.tokensPath).toMatch(/^\/tmp\/build-scratch\/worker-\d+\/mission-control-tokens\.json$/)
  })

  it('prefers build-specific db and token overrides during next build', async () => {
    const config = await loadConfigWithEnv({
      NEXT_PHASE: 'phase-production-build',
      MISSION_CONTROL_DATA_DIR: '/tmp/runtime-data',
      MISSION_CONTROL_DB_PATH: '/tmp/runtime.db',
      MISSION_CONTROL_TOKENS_PATH: '/tmp/runtime-tokens.json',
      MISSION_CONTROL_BUILD_DB_PATH: '/tmp/build.db',
      MISSION_CONTROL_BUILD_TOKENS_PATH: '/tmp/build-tokens.json',
    })

    const expectedBuildRoot = path.join(os.tmpdir(), 'mission-control-build')
    expect(config.dataDir).toMatch(new RegExp(`^${expectedBuildRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/worker-\\d+$`))
    expect(config.dbPath).toBe('/tmp/build.db')
    expect(config.tokensPath).toBe('/tmp/build-tokens.json')
  })

  it('prefers DATABASE_URL when postgres mode is enabled', async () => {
    const config = await loadConfigWithEnv({
      MISSION_CONTROL_DB_PROVIDER: 'postgres',
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/mission_control',
      MISSION_CONTROL_DB_PATH: '/tmp/ignored.db',
    })

    expect(config.dbProvider).toBe('postgres')
    expect(config.databaseUrl).toBe('postgresql://postgres:postgres@127.0.0.1:5432/mission_control')
    expect(config.dbPath).toBe('/tmp/ignored.db')
  })
})
