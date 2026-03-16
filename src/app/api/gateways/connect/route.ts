import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { buildGatewayWebSocketUrl } from '@/lib/gateway-url'
import { getDetectedGatewayToken } from '@/lib/gateway-runtime'
import { getPrismaClient } from '@/lib/prisma'
import {
  isTailscaleServe,
  refreshTailscaleCache,
  getCachedTailscaleWeb,
  hasGwPathHandler,
  findTailscaleServePort,
} from '@/lib/tailscale-serve'

interface GatewayEntry {
  id: number
  host: string
  port: number
  token: string
  is_primary: number
}

function inferBrowserProtocol(request: NextRequest): 'http:' | 'https:' {
  const forwardedProto = String(request.headers.get('x-forwarded-proto') || '').split(',')[0]?.trim().toLowerCase()
  if (forwardedProto === 'https') return 'https:'
  if (forwardedProto === 'http') return 'http:'

  const origin = request.headers.get('origin') || request.headers.get('referer') || ''
  if (origin) {
    try {
      const parsed = new URL(origin)
      if (parsed.protocol === 'https:') return 'https:'
      if (parsed.protocol === 'http:') return 'http:'
    } catch {
      // ignore and continue fallback resolution
    }
  }

  if (request.nextUrl.protocol === 'https:') return 'https:'
  return 'http:'
}

const LOCALHOST_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** Extract the browser-facing hostname from the request. */
function getBrowserHostname(request: NextRequest): string {
  const origin = request.headers.get('origin') || request.headers.get('referer') || ''
  if (origin) {
    try { return new URL(origin).hostname } catch { /* ignore */ }
  }
  const hostHeader = request.headers.get('host') || ''
  return hostHeader.split(':')[0]
}

/**
 * When the gateway is on localhost but the browser is remote, resolve the
 * correct WebSocket URL the browser should use.
 *
 * - Tailscale Serve mode: `wss://<dashboard-host>/gw` (Tailscale proxies /gw to localhost gateway)
 * - Otherwise: rewrite host to dashboard hostname with the gateway port
 */
function resolveRemoteGatewayUrl(
  gateway: { host: string; port: number },
  request: NextRequest,
): string | null {
  const normalized = (gateway.host || '').toLowerCase().trim()
  if (!LOCALHOST_HOSTS.has(normalized)) return null // remote host — use normal path

  const browserHost = getBrowserHostname(request)
  if (!browserHost || LOCALHOST_HOSTS.has(browserHost.toLowerCase())) return null // local access

  // Browser is remote — determine the correct proxied URL
  if (isTailscaleServe()) {
    // Check for a /gw path-based proxy first
    refreshTailscaleCache()
    const web = getCachedTailscaleWeb()
    if (hasGwPathHandler(web)) {
      return `wss://${browserHost}/gw`
    }
    // Port-based proxy: find the Tailscale Serve port that proxies to the gateway port
    const tsPort = findTailscaleServePort(web, gateway.port)
    if (tsPort) {
      return `wss://${browserHost}:${tsPort}`
    }
  }

  // No Tailscale Serve — try direct connection to dashboard host on gateway port
  const protocol = inferBrowserProtocol(request) === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${browserHost}:${gateway.port}`
}

/**
 * POST /api/gateways/connect
 * Resolves websocket URL and token for a selected gateway without exposing tokens in list payloads.
 */
export async function POST(request: NextRequest) {
  // Any authenticated dashboard user may initiate a gateway websocket connect.
  // Restricting this to operator can cause startup fallback to connect without auth,
  // which then fails as "device identity required".
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const prisma = getPrismaClient()

  let id: number | null = null
  try {
    const body = await request.json()
    id = Number(body?.id)
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!id || !Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const gateway = await prisma.gateways.findFirst({
    where: { id },
    select: { id: true, host: true, port: true, token: true, is_primary: true },
  }) as unknown as GatewayEntry | null
  if (!gateway) {
    return NextResponse.json({ error: 'Gateway not found' }, { status: 404 })
  }

  // Prefer an explicitly configured browser WebSocket URL when provided.
  // This is required for reverse-proxy setups where the browser-facing gateway
  // lives on a different host/path than the server-side localhost gateway.
  const explicitBrowserWsUrl = String(process.env.NEXT_PUBLIC_GATEWAY_URL || '').trim()

  // When gateway host is localhost but the browser is remote (e.g. Tailscale),
  // resolve the correct browser-accessible WebSocket URL.
  const remoteUrl = explicitBrowserWsUrl || resolveRemoteGatewayUrl(gateway, request)
  const ws_url = remoteUrl || buildGatewayWebSocketUrl({
    host: gateway.host,
    port: gateway.port,
    browserProtocol: inferBrowserProtocol(request),
  })

  const dbToken = (gateway.token || '').trim()
  const detectedToken = gateway.is_primary === 1 ? getDetectedGatewayToken() : ''
  const token = detectedToken || dbToken

  // Keep runtime DB aligned with detected OpenClaw gateway token for primary gateway.
  if (gateway.is_primary === 1 && detectedToken && detectedToken !== dbToken) {
    try {
      await prisma.gateways.updateMany({
        where: { id: gateway.id },
        data: { token: detectedToken, updated_at: Math.floor(Date.now() / 1000) } as any,
      })
    } catch {
      // Non-fatal: connect still succeeds with detected token even if persistence fails.
    }
  }

  return NextResponse.json({
    id: gateway.id,
    ws_url,
    token,
    token_set: token.length > 0,
  })
}
