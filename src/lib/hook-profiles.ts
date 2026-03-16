/**
 * Hook Profiles — security hook configuration levels.
 *
 * Three profiles control how aggressively security hooks run:
 * - minimal: lightweight, no blocking
 * - standard: default, scans secrets and audits MCP calls
 * - strict: blocks on secret detection, tighter rate limits
 *
 * Profile is stored in the settings table under key 'hook_profile'.
 */

import { getPrismaClient } from '@/lib/prisma'

export type HookProfileLevel = 'minimal' | 'standard' | 'strict'

export interface HookProfile {
  level: HookProfileLevel
  scanSecrets: boolean
  auditMcpCalls: boolean
  blockOnSecretDetection: boolean
  rateLimitMultiplier: number
}

const PROFILES: Record<HookProfileLevel, HookProfile> = {
  minimal: {
    level: 'minimal',
    scanSecrets: false,
    auditMcpCalls: false,
    blockOnSecretDetection: false,
    rateLimitMultiplier: 2.0,
  },
  standard: {
    level: 'standard',
    scanSecrets: true,
    auditMcpCalls: true,
    blockOnSecretDetection: false,
    rateLimitMultiplier: 1.0,
  },
  strict: {
    level: 'strict',
    scanSecrets: true,
    auditMcpCalls: true,
    blockOnSecretDetection: true,
    rateLimitMultiplier: 0.5,
  },
}

export async function getActiveProfile(): Promise<HookProfile> {
  const prisma = getPrismaClient()
  const row = await prisma.settings.findUnique({
    where: { key: 'hook_profile' },
    select: { value: true },
  }).catch(() => null)

  const level = row?.value as HookProfileLevel
  if (level && PROFILES[level]) {
    return PROFILES[level]
  }
  return PROFILES.standard
}

export async function shouldScanSecrets(): Promise<boolean> {
  return (await getActiveProfile()).scanSecrets
}

export async function shouldAuditMcpCalls(): Promise<boolean> {
  return (await getActiveProfile()).auditMcpCalls
}

export async function shouldBlockOnSecretDetection(): Promise<boolean> {
  return (await getActiveProfile()).blockOnSecretDetection
}

export async function getRateLimitMultiplier(): Promise<number> {
  return (await getActiveProfile()).rateLimitMultiplier
}
