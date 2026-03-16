import { NextRequest, NextResponse } from 'next/server'
import net from 'node:net'
import { existsSync } from 'node:fs'
import { requireRole } from '@/lib/auth'
import { config } from '@/lib/config'
import { getDatabaseHealthSnapshot } from '@/lib/database-ops'
import { runOpenClaw } from '@/lib/command'
import { logger } from '@/lib/logger'
import { APP_VERSION } from '@/lib/version'
import { getPrismaClient } from '@/lib/prisma'

const INSECURE_PASSWORDS = new Set([
  'admin',
  'password',
  'change-me-on-first-login',
  'changeme',
  'testpass123',
])

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const [version, security, database, agents, sessions, gateway] = await Promise.all([
      getVersionInfo(),
      getSecurityInfo(),
      getDatabaseInfo(),
      getAgentInfo(),
      getSessionInfo(),
      getGatewayInfo(),
    ])

    return NextResponse.json({
      system: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        processMemory: process.memoryUsage(),
        processUptime: process.uptime(),
        isDocker: existsSync('/.dockerenv'),
      },
      version,
      security,
      database,
      agents,
      sessions,
      gateway,
      retention: config.retention,
    })
  } catch (error) {
    logger.error({ err: error }, 'Diagnostics API error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

async function getVersionInfo() {
  let openclaw: string | null = null
  try {
    const { stdout } = await runOpenClaw(['--version'], { timeoutMs: 3000 })
    openclaw = stdout.trim()
  } catch {
    // openclaw not available
  }
  return { app: APP_VERSION, openclaw }
}

function getSecurityInfo() {
  const checks: Array<{ name: string; pass: boolean; detail: string }> = []

  const apiKey = process.env.API_KEY || ''
  checks.push({
    name: 'API key configured',
    pass: Boolean(apiKey) && apiKey !== 'generate-a-random-key',
    detail: !apiKey ? 'API_KEY is not set' : apiKey === 'generate-a-random-key' ? 'API_KEY is default value' : 'API_KEY is set',
  })

  const authPass = process.env.AUTH_PASS || ''
  checks.push({
    name: 'Auth password secure',
    pass: Boolean(authPass) && !INSECURE_PASSWORDS.has(authPass),
    detail: !authPass ? 'AUTH_PASS is not set' : INSECURE_PASSWORDS.has(authPass) ? 'AUTH_PASS is a known insecure password' : 'AUTH_PASS is not a common default',
  })

  const allowedHosts = process.env.MC_ALLOWED_HOSTS || ''
  checks.push({
    name: 'Allowed hosts configured',
    pass: Boolean(allowedHosts.trim()),
    detail: allowedHosts.trim() ? 'MC_ALLOWED_HOSTS is configured' : 'MC_ALLOWED_HOSTS is not set',
  })

  const sameSite = process.env.MC_COOKIE_SAMESITE || ''
  checks.push({
    name: 'Cookie SameSite strict',
    pass: sameSite.toLowerCase() === 'strict',
    detail: sameSite ? `MC_COOKIE_SAMESITE is '${sameSite}'` : 'MC_COOKIE_SAMESITE is not set',
  })

  const hsts = process.env.MC_ENABLE_HSTS || ''
  checks.push({
    name: 'HSTS enabled',
    pass: hsts === '1',
    detail: hsts === '1' ? 'HSTS is enabled' : 'MC_ENABLE_HSTS is not set to 1',
  })

  const rateLimitDisabled = process.env.MC_DISABLE_RATE_LIMIT || ''
  checks.push({
    name: 'Rate limiting enabled',
    pass: !rateLimitDisabled,
    detail: rateLimitDisabled ? 'Rate limiting is disabled' : 'Rate limiting is active',
  })

  const gwHost = config.gatewayHost
  checks.push({
    name: 'Gateway bound to localhost',
    pass: gwHost === '127.0.0.1' || gwHost === 'localhost',
    detail: `Gateway host is '${gwHost}'`,
  })

  const passing = checks.filter(c => c.pass).length
  const score = Math.round((passing / checks.length) * 100)

  return { score, checks }
}

async function getDatabaseInfo() {
  try {
    return await getDatabaseHealthSnapshot()
  } catch (err) {
    logger.error({ err }, 'Diagnostics: database info error')
    return { provider: config.dbProvider, sizeBytes: 0, walMode: false, migrationVersion: null, target: null }
  }
}

function getAgentInfo() {
  return (async () => {
    try {
      const prisma = getPrismaClient()
      const rows = await prisma.$queryRaw<any[]>`
        SELECT status, COUNT(*) as count
        FROM agents
        GROUP BY status
      `

      const byStatus: Record<string, number> = {}
      let total = 0
      for (const row of rows) {
        const status = String(row.status || '')
        const count = Number(row.count ?? 0)
        if (!status) continue
        byStatus[status] = count
        total += count
      }
      return { total, byStatus }
    } catch {
      return { total: 0, byStatus: {} }
    }
  })()
}

function getSessionInfo() {
  return (async () => {
    try {
      const prisma = getPrismaClient()
      const [total, active] = await Promise.all([
        prisma.claude_sessions.count(),
        prisma.claude_sessions.count({ where: { is_active: 1 } as any }),
      ])
      return { active, total }
    } catch {
      return { active: 0, total: 0 }
    }
  })()
}

async function getGatewayInfo() {
  const host = config.gatewayHost
  const port = config.gatewayPort
  const configured = Boolean(host && port)

  let reachable = false
  if (configured) {
    reachable = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket()
      socket.setTimeout(1500)
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('timeout', () => { socket.destroy(); resolve(false) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
      socket.connect(port, host)
    })
  }

  return { configured, reachable, host, port }
}
