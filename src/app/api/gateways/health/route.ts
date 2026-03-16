import { NextRequest, NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getPrismaClient } from "@/lib/prisma"

interface GatewayEntry {
  id: number
  name: string
  host: string
  port: number
  token: string
  is_primary: number
  status: string
}

interface HealthResult {
  id: number
  name: string
  status: "online" | "offline" | "error"
  latency: number | null
  agents: string[]
  sessions_count: number
  gateway_version?: string | null
  compatibility_warning?: string
  error?: string
}

function parseGatewayVersion(res: Response): string | null {
  const direct = res.headers.get('x-openclaw-version') || res.headers.get('x-clawdbot-version')
  if (direct) return direct.trim()
  const server = res.headers.get('server') || ''
  const m = server.match(/(\d{4}\.\d+\.\d+)/)
  return m?.[1] || null
}

function hasOpenClaw32ToolsProfileRisk(version: string | null): boolean {
  if (!version) return false
  const m = version.match(/^(\d{4})\.(\d+)\.(\d+)/)
  if (!m) return false
  const year = Number(m[1])
  const major = Number(m[2])
  const minor = Number(m[3])
  if (year > 2026) return true
  if (year < 2026) return false
  if (major > 3) return true
  if (major < 3) return false
  return minor >= 2
}

/** Check whether an IPv4 address falls within a CIDR block. */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/')
  const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0
  const ipNum = ipv4ToNum(ip)
  const baseNum = ipv4ToNum(base)
  if (ipNum === null || baseNum === null) return false
  return (ipNum & mask) === (baseNum & mask)
}

function ipv4ToNum(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let num = 0
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isFinite(n) || n < 0 || n > 255) return null
    num = (num << 8) | n
  }
  return num >>> 0
}

const BLOCKED_PRIVATE_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '127.0.0.0/8',
]

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.internal',
  'instance-data',
])

function isBlockedUrl(urlStr: string, userConfiguredHosts: Set<string>): boolean {
  try {
    const url = new URL(urlStr)
    const hostname = url.hostname

    // Allow user-configured gateway hosts (operators intentionally target their own infra)
    if (userConfiguredHosts.has(hostname)) return false

    // Block well-known cloud metadata hostnames
    if (BLOCKED_HOSTNAMES.has(hostname)) return true

    // Block private/reserved IPv4 ranges
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
      for (const cidr of BLOCKED_PRIVATE_CIDRS) {
        if (ipv4InCidr(hostname, cidr)) return true
      }
    }

    return false
  } catch {
    return true // Block malformed URLs
  }
}

function buildGatewayProbeUrl(host: string, port: number): string | null {
  const rawHost = String(host || '').trim()
  if (!rawHost) return null

  const hasProtocol =
    rawHost.startsWith('ws://') ||
    rawHost.startsWith('wss://') ||
    rawHost.startsWith('http://') ||
    rawHost.startsWith('https://')

  if (hasProtocol) {
    try {
      const parsed = new URL(rawHost)
      if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
      if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
      if (!parsed.port && Number.isFinite(port) && port > 0) {
        parsed.port = String(port)
      }
      if (!parsed.pathname) parsed.pathname = '/'
      return parsed.toString()
    } catch {
      return null
    }
  }

  if (!Number.isFinite(port) || port <= 0) return null
  return `http://${rawHost}:${port}/`
}

/**
 * POST /api/gateways/health - Server-side health probe for all gateways
 * Probes gateways from the server where loopback addresses are reachable.
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, "viewer")
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const prisma = getPrismaClient()
  const gateways = await prisma.gateways.findMany({
    orderBy: [{ is_primary: 'desc' }, { name: 'asc' }],
  }) as unknown as GatewayEntry[]

  // Build set of user-configured gateway hosts so the SSRF filter allows them
  const configuredHosts = new Set<string>()
  for (const gw of gateways) {
    const h = (gw.host || '').trim()
    if (h) {
      try { configuredHosts.add(new URL(h.includes('://') ? h : `http://${h}`).hostname) } catch { configuredHosts.add(h) }
    }
  }

  const results: HealthResult[] = []
  const logs: Array<{ gateway_id: number; status: string; latency: number | null; probed_at: number; error: string | null }> = []

  for (const gw of gateways) {
    const probedAt = Math.floor(Date.now() / 1000)
    const probeUrl = buildGatewayProbeUrl(gw.host, gw.port)
    if (!probeUrl) {
      const error = 'Invalid gateway address'
      logs.push({ gateway_id: gw.id, status: 'error', latency: null, probed_at: probedAt, error })
      results.push({ id: gw.id, name: gw.name, status: 'error', latency: null, agents: [], sessions_count: 0, error })
      continue
    }

    if (isBlockedUrl(probeUrl, configuredHosts)) {
      const error = 'Blocked URL'
      logs.push({ gateway_id: gw.id, status: 'error', latency: null, probed_at: probedAt, error })
      results.push({ id: gw.id, name: gw.name, status: 'error', latency: null, agents: [], sessions_count: 0, error })
      continue
    }

    const start = Date.now()
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)

      const res = await fetch(probeUrl, {
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const latency = Date.now() - start
      const status = res.ok ? "online" : "error"
      const gatewayVersion = parseGatewayVersion(res)
      const compatibilityWarning = hasOpenClaw32ToolsProfileRisk(gatewayVersion)
        ? 'OpenClaw 2026.3.2+ defaults tools.profile=messaging; Mission Control should enforce coding profile when spawning.'
        : undefined

      const errorMessage = res.ok ? null : `HTTP ${res.status}`
      logs.push({ gateway_id: gw.id, status, latency, probed_at: probedAt, error: errorMessage })

      results.push({
        id: gw.id,
        name: gw.name,
        status: status as "online" | "error",
        latency,
        agents: [],
        sessions_count: 0,
        gateway_version: gatewayVersion,
        compatibility_warning: compatibilityWarning,
        ...(errorMessage ? { error: errorMessage } : {}),
      })
    } catch (err: any) {
      const errorMessage = err.name === "AbortError" ? "timeout" : (err.message || "connection failed")
      logs.push({ gateway_id: gw.id, status: 'offline', latency: null, probed_at: probedAt, error: errorMessage })
      results.push({
        id: gw.id,
        name: gw.name,
        status: "offline" as const,
        latency: null,
        agents: [],
        sessions_count: 0,
        error: errorMessage,
      })
    }
  }

  // Persist probe results
  const now = Math.floor(Date.now() / 1000)
  const ops: any[] = []
  if (logs.length > 0) {
    ops.push(
      prisma.gateway_health_logs.createMany({
        data: logs.map((l) => ({ ...l }) as any),
      })
    )
  }

  for (const r of results) {
      if (r.status === 'online' || r.status === 'error') {
        ops.push(prisma.gateways.updateMany({
          where: { id: r.id },
          data: { status: r.status, latency: r.latency, last_seen: now, updated_at: now } as any,
        }))
      } else {
        ops.push(prisma.gateways.updateMany({
          where: { id: r.id },
          data: { status: r.status, latency: null, updated_at: now } as any,
        }))
      }
  }

  if (ops.length > 0) {
    await prisma.$transaction(ops)
  }

  return NextResponse.json({ results, probed_at: Date.now() })
}
