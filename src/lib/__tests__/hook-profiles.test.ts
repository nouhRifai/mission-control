import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFindUnique = vi.fn()

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: () => ({
    settings: {
      findUnique: mockFindUnique,
    },
  }),
}))

import {
  getActiveProfile,
  shouldScanSecrets,
  shouldAuditMcpCalls,
  shouldBlockOnSecretDetection,
  getRateLimitMultiplier,
} from '@/lib/hook-profiles'

describe('getActiveProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns standard profile by default', async () => {
    mockFindUnique.mockResolvedValue(null)
    const profile = await getActiveProfile()
    expect(profile.level).toBe('standard')
    expect(profile.scanSecrets).toBe(true)
    expect(profile.auditMcpCalls).toBe(true)
    expect(profile.blockOnSecretDetection).toBe(false)
    expect(profile.rateLimitMultiplier).toBe(1.0)
  })

  it('returns minimal profile when set', async () => {
    mockFindUnique.mockResolvedValue({ value: 'minimal' })
    const profile = await getActiveProfile()
    expect(profile.level).toBe('minimal')
    expect(profile.scanSecrets).toBe(false)
    expect(profile.auditMcpCalls).toBe(false)
    expect(profile.blockOnSecretDetection).toBe(false)
    expect(profile.rateLimitMultiplier).toBe(2.0)
  })

  it('returns strict profile when set', async () => {
    mockFindUnique.mockResolvedValue({ value: 'strict' })
    const profile = await getActiveProfile()
    expect(profile.level).toBe('strict')
    expect(profile.scanSecrets).toBe(true)
    expect(profile.auditMcpCalls).toBe(true)
    expect(profile.blockOnSecretDetection).toBe(true)
    expect(profile.rateLimitMultiplier).toBe(0.5)
  })

  it('falls back to standard for unknown profile value', async () => {
    mockFindUnique.mockResolvedValue({ value: 'nonexistent' })
    const profile = await getActiveProfile()
    expect(profile.level).toBe('standard')
  })
})

describe('shouldScanSecrets', () => {
  it('returns true for standard profile', async () => {
    mockFindUnique.mockResolvedValue({ value: 'standard' })
    expect(await shouldScanSecrets()).toBe(true)
  })

  it('returns false for minimal profile', async () => {
    mockFindUnique.mockResolvedValue({ value: 'minimal' })
    expect(await shouldScanSecrets()).toBe(false)
  })

  it('returns true for strict profile', async () => {
    mockFindUnique.mockResolvedValue({ value: 'strict' })
    expect(await shouldScanSecrets()).toBe(true)
  })
})

describe('shouldAuditMcpCalls', () => {
  it('returns false for minimal profile', async () => {
    mockFindUnique.mockResolvedValue({ value: 'minimal' })
    expect(await shouldAuditMcpCalls()).toBe(false)
  })

  it('returns true for standard profile', async () => {
    mockFindUnique.mockResolvedValue({ value: 'standard' })
    expect(await shouldAuditMcpCalls()).toBe(true)
  })
})

describe('shouldBlockOnSecretDetection', () => {
  it('returns false for standard profile', async () => {
    mockFindUnique.mockResolvedValue({ value: 'standard' })
    expect(await shouldBlockOnSecretDetection()).toBe(false)
  })

  it('returns true for strict profile', async () => {
    mockFindUnique.mockResolvedValue({ value: 'strict' })
    expect(await shouldBlockOnSecretDetection()).toBe(true)
  })
})

describe('getRateLimitMultiplier', () => {
  it('returns 1.0 for standard', async () => {
    mockFindUnique.mockResolvedValue({ value: 'standard' })
    expect(await getRateLimitMultiplier()).toBe(1.0)
  })

  it('returns 2.0 for minimal', async () => {
    mockFindUnique.mockResolvedValue({ value: 'minimal' })
    expect(await getRateLimitMultiplier()).toBe(2.0)
  })

  it('returns 0.5 for strict', async () => {
    mockFindUnique.mockResolvedValue({ value: 'strict' })
    expect(await getRateLimitMultiplier()).toBe(0.5)
  })
})
