import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSecurityEventsCreate = vi.fn(async () => ({ id: 42 }))
const mockSecurityEventsCount = vi.fn(async () => 0)

const mockTrustUpsert = vi.fn(async () => ({ id: 1 }))
const mockTrustUpdate = vi.fn(async (_args: any) => ({ id: 1 }))
const mockTrustFindUnique = vi.fn(async () => ({
  agent_name: 'test-agent',
  workspace_id: 1,
  trust_score: 0.95,
  auth_failures: 1,
  injection_attempts: 0,
  rate_limit_hits: 0,
  secret_exposures: 0,
  successful_tasks: 5,
  failed_tasks: 0,
  last_anomaly_at: null,
}))
const mockTrustAggregate = vi.fn(async () => ({ _avg: { trust_score: 1.0 } }))

const mockPrisma = {
  security_events: {
    create: mockSecurityEventsCreate,
    count: mockSecurityEventsCount,
  },
  agent_trust_scores: {
    upsert: mockTrustUpsert,
    update: mockTrustUpdate,
    findUnique: mockTrustFindUnique,
    aggregate: mockTrustAggregate,
  },
} as any

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: () => mockPrisma,
}))

vi.mock('@/lib/event-bus', () => ({
  eventBus: { broadcast: vi.fn() },
}))

import { logSecurityEvent, updateAgentTrustScore, getSecurityPosture } from '@/lib/security-events'

describe('logSecurityEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSecurityEventsCreate.mockResolvedValue({ id: 42 })
  })

  it('inserts an event into the database', async () => {
    const id = await logSecurityEvent({
      event_type: 'auth_failure',
      severity: 'warning',
      source: 'auth',
      detail: 'test detail',
    })

    expect(mockSecurityEventsCreate).toHaveBeenCalled()
    expect(id).toBe(42)
  })

  it('defaults severity to info when not provided', async () => {
    await logSecurityEvent({ event_type: 'test_event' })
    expect(mockSecurityEventsCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event_type: 'test_event', severity: 'info' }),
    }))
  })

  it('uses provided workspace_id and tenant_id', async () => {
    await logSecurityEvent({
      event_type: 'test_event',
      severity: 'critical',
      workspace_id: 5,
      tenant_id: 3,
    })
    expect(mockSecurityEventsCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspace_id: 5, tenant_id: 3 }),
    }))
  })

  it('broadcasts via event bus', async () => {
    const { eventBus } = await import('@/lib/event-bus')
    await logSecurityEvent({ event_type: 'injection_attempt', severity: 'critical' })
    expect(eventBus.broadcast).toHaveBeenCalledWith(
      'security.event',
      expect.objectContaining({ event_type: 'injection_attempt', severity: 'critical' })
    )
  })
})

describe('updateAgentTrustScore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTrustFindUnique.mockResolvedValue({
      agent_name: 'test-agent',
      workspace_id: 1,
      trust_score: 0.95,
      auth_failures: 1,
      injection_attempts: 0,
      rate_limit_hits: 0,
      secret_exposures: 0,
      successful_tasks: 5,
      failed_tasks: 0,
      last_anomaly_at: null,
    })
  })

  it('creates a row if one does not exist', async () => {
    await updateAgentTrustScore('test-agent', 'auth.failure', 1)
    expect(mockTrustUpsert).toHaveBeenCalled()
  })

	  it('recalculates trust score clamped between 0 and 1', async () => {
	    mockTrustFindUnique.mockResolvedValue({
	      agent_name: 'bad-agent',
	      workspace_id: 1,
	      auth_failures: 20,
	      injection_attempts: 10,
	      rate_limit_hits: 5,
	      secret_exposures: 3,
      successful_tasks: 0,
      failed_tasks: 0,
      trust_score: 0,
      last_anomaly_at: null,
    })

    await updateAgentTrustScore('bad-agent', 'injection.attempt', 1)
    const updateCalls = mockTrustUpdate.mock.calls
    const lastUpdate = updateCalls[updateCalls.length - 1]?.[0]
    expect(lastUpdate?.data?.trust_score).toBeGreaterThanOrEqual(0)
    expect(lastUpdate?.data?.trust_score).toBeLessThanOrEqual(1)
  })
})

describe('getSecurityPosture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns expected posture shape', async () => {
    mockSecurityEventsCount
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(3)
    mockTrustAggregate.mockResolvedValueOnce({ _avg: { trust_score: 0.85 } })

    const posture = await getSecurityPosture(1)
    expect(posture).toHaveProperty('score')
    expect(posture).toHaveProperty('totalEvents')
    expect(posture).toHaveProperty('criticalEvents')
    expect(posture).toHaveProperty('warningEvents')
    expect(posture).toHaveProperty('avgTrustScore')
    expect(posture).toHaveProperty('recentIncidents')
    expect(typeof posture.score).toBe('number')
    expect(posture.score).toBeGreaterThanOrEqual(0)
    expect(posture.score).toBeLessThanOrEqual(100)
  })

  it('deducts points for critical and warning events', async () => {
    mockSecurityEventsCount
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(5)
    mockTrustAggregate.mockResolvedValueOnce({ _avg: { trust_score: 1.0 } })

    const posture = await getSecurityPosture(1)
    expect(posture.score).toBeLessThan(100)
  })

  it('returns score of 100 with no events', async () => {
    mockSecurityEventsCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
    mockTrustAggregate.mockResolvedValueOnce({ _avg: { trust_score: 1.0 } })

    const posture = await getSecurityPosture(1)
    expect(posture.score).toBe(100)
  })
})

describe('injection guard new rules', () => {
  let scanForInjection: typeof import('@/lib/injection-guard').scanForInjection

  beforeEach(async () => {
    const mod = await import('@/lib/injection-guard')
    scanForInjection = mod.scanForInjection
  })

  it('detects SSRF targeting metadata endpoint', () => {
    const report = scanForInjection('curl http://169.254.169.254/latest/meta-data/', { context: 'shell' })
    expect(report.safe).toBe(false)
    expect(report.matches.some(m => m.rule === 'cmd-ssrf')).toBe(true)
  })

  it('detects SSRF targeting localhost', () => {
    const report = scanForInjection('wget http://localhost:8080/admin', { context: 'shell' })
    expect(report.safe).toBe(false)
    expect(report.matches.some(m => m.rule === 'cmd-ssrf')).toBe(true)
  })

  it('detects template injection (Jinja2)', () => {
    const report = scanForInjection('{{config.__class__.__init__.__globals__}}', { context: 'prompt' })
    expect(report.safe).toBe(false)
    expect(report.matches.some(m => m.rule === 'cmd-template-injection')).toBe(true)
  })

  it('detects SQL injection (UNION SELECT)', () => {
    const report = scanForInjection("' UNION SELECT * FROM users --", { context: 'shell' })
    expect(report.safe).toBe(false)
    expect(report.matches.some(m => m.rule === 'cmd-sql-injection')).toBe(true)
  })

  it('detects SQL injection (OR 1=1)', () => {
    const report = scanForInjection("' OR 1=1 --", { context: 'shell' })
    expect(report.safe).toBe(false)
    expect(report.matches.some(m => m.rule === 'cmd-sql-injection')).toBe(true)
  })

  it('does not false-positive on normal SQL mentions', () => {
    const report = scanForInjection('SELECT name FROM products WHERE id = 5', { context: 'shell' })
    // This should not trigger because it lacks injection markers
    expect(report.matches.filter(m => m.rule === 'cmd-sql-injection')).toHaveLength(0)
  })
})
