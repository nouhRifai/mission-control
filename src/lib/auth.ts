import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { hashPassword, verifyPassword } from './password'
import { logSecurityEvent } from './security-events'
import { parseMcSessionCookieHeader } from './session-cookie'
import { getPrismaClient } from './prisma'

// Plugin hook: extensions can register a custom API key resolver without modifying this file.
type AuthResolverHook = (apiKey: string, agentName: string | null) => User | null | Promise<User | null>
let _authResolverHook: AuthResolverHook | null = null
export function registerAuthResolver(hook: AuthResolverHook): void {
  _authResolverHook = hook
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    // Compare against dummy buffer to avoid timing leak on length mismatch
    const dummy = Buffer.alloc(bufA.length)
    timingSafeEqual(bufA, dummy)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

export interface User {
  id: number
  username: string
  display_name: string
  role: 'admin' | 'operator' | 'viewer'
  workspace_id: number
  tenant_id: number
  provider?: 'local' | 'google' | 'proxy'
  email?: string | null
  avatar_url?: string | null
  is_approved?: number
  created_at: number
  updated_at: number
  last_login_at: number | null
  /** Agent name when request is made on behalf of a specific agent (via X-Agent-Name header) */
  agent_name?: string | null
}

export interface UserSession {
  id: number
  token: string
  user_id: number
  workspace_id: number
  tenant_id: number
  expires_at: number
  created_at: number
  ip_address: string | null
  user_agent: string | null
}

interface SessionQueryRow {
  id: number
  username: string
  display_name: string
  role: 'admin' | 'operator' | 'viewer'
  provider: 'local' | 'google' | null
  email: string | null
  avatar_url: string | null
  is_approved: number
  workspace_id: number
  tenant_id: number
  created_at: number
  updated_at: number
  last_login_at: number | null
  session_id: number
}

interface UserQueryRow {
  id: number
  username: string
  display_name: string
  role: 'admin' | 'operator' | 'viewer'
  provider: 'local' | 'google' | null
  email: string | null
  avatar_url: string | null
  is_approved: number
  workspace_id: number
  tenant_id?: number
  created_at: number
  updated_at: number
  last_login_at: number | null
  password_hash: string
}

// Session management
const SESSION_DURATION = 7 * 24 * 60 * 60 // 7 days in seconds

async function getDefaultWorkspaceContext(): Promise<{ workspaceId: number; tenantId: number }> {
  try {
    const prisma = getPrismaClient()
    const preferred = await prisma.workspaces.findUnique({
      where: { slug: 'default' },
      select: { id: true, tenant_id: true },
    })
    const row = preferred || await prisma.workspaces.findFirst({
      orderBy: { id: 'asc' },
      select: { id: true, tenant_id: true },
    })
    return {
      workspaceId: row?.id || 1,
      tenantId: row?.tenant_id || 1,
    }
  } catch {
    return { workspaceId: 1, tenantId: 1 }
  }
}

export async function getWorkspaceIdFromRequest(request: Request): Promise<number> {
  const user = await getUserFromRequest(request)
  return user?.workspace_id || (await getDefaultWorkspaceContext()).workspaceId
}

export async function getTenantIdFromRequest(request: Request): Promise<number> {
  const user = await getUserFromRequest(request)
  return user?.tenant_id || (await getDefaultWorkspaceContext()).tenantId
}

async function resolveTenantForWorkspace(workspaceId: number): Promise<number> {
  const prisma = getPrismaClient()
  const row = await prisma.workspaces.findUnique({
    where: { id: workspaceId },
    select: { tenant_id: true },
  })
  return row?.tenant_id || (await getDefaultWorkspaceContext()).tenantId
}

export async function createSession(
  userId: number,
  ipAddress?: string,
  userAgent?: string,
  workspaceId?: number
): Promise<{ token: string; expiresAt: number }> {
  const prisma = getPrismaClient()
  const token = randomBytes(32).toString('hex')
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + SESSION_DURATION
  const defaultCtx = await getDefaultWorkspaceContext()
  const user = await prisma.users.findUnique({ where: { id: userId }, select: { workspace_id: true } })
  const resolvedWorkspaceId = workspaceId ?? user?.workspace_id ?? defaultCtx.workspaceId
  const resolvedTenantId = await resolveTenantForWorkspace(resolvedWorkspaceId)

  await prisma.user_sessions.create({
    data: {
      token,
      user_id: userId,
      expires_at: expiresAt,
      ip_address: ipAddress || null,
      user_agent: userAgent || null,
      workspace_id: resolvedWorkspaceId,
      tenant_id: resolvedTenantId,
      created_at: now,
    },
    select: { id: true },
  })

  // Update user's last login
  await prisma.users.update({
    where: { id: userId },
    data: { last_login_at: now, updated_at: now },
    select: { id: true },
  })

  // Clean up expired sessions
  await prisma.user_sessions.deleteMany({ where: { expires_at: { lt: now } } })

  return { token, expiresAt }
}

export async function validateSession(token: string): Promise<(User & { sessionId: number }) | null> {
  if (!token) return null
  const prisma = getPrismaClient()
  const now = Math.floor(Date.now() / 1000)

  const session = await prisma.user_sessions.findFirst({
    where: { token, expires_at: { gt: now } },
    include: { users: true },
  })

  if (!session || !session.users) return null
  const workspaceId = session.workspace_id || session.users.workspace_id || (await getDefaultWorkspaceContext()).workspaceId
  const workspace = await prisma.workspaces.findUnique({
    where: { id: workspaceId },
    select: { tenant_id: true },
  })
  const tenantId = session.tenant_id || workspace?.tenant_id || (await getDefaultWorkspaceContext()).tenantId

  return {
    id: session.users.id,
    username: session.users.username,
    display_name: session.users.display_name,
    role: session.users.role as User['role'],
    workspace_id: workspaceId,
    tenant_id: tenantId,
    provider: (session.users.provider as User['provider']) || 'local',
    email: session.users.email ?? null,
    avatar_url: session.users.avatar_url ?? null,
    is_approved: typeof session.users.is_approved === 'number' ? session.users.is_approved : 1,
    created_at: session.users.created_at,
    updated_at: session.users.updated_at,
    last_login_at: session.users.last_login_at ?? null,
    sessionId: session.id,
  }
}

export async function destroySession(token: string): Promise<void> {
  const prisma = getPrismaClient()
  await prisma.user_sessions.deleteMany({ where: { token } })
}

export async function destroyAllUserSessions(userId: number): Promise<void> {
  const prisma = getPrismaClient()
  await prisma.user_sessions.deleteMany({ where: { user_id: userId } })
}

// Dummy hash used for constant-time rejection when user doesn't exist.
// This ensures authenticateUser takes the same time whether or not the username is valid,
// preventing timing-based username enumeration.
const DUMMY_HASH = '0000000000000000000000000000000000000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000'

// User management
export async function authenticateUser(username: string, password: string): Promise<User | null> {
  const prisma = getPrismaClient()
  const row = await prisma.users.findUnique({ where: { username }, select: {
    id: true,
    username: true,
    display_name: true,
    role: true,
    provider: true,
    provider_user_id: true,
    email: true,
    avatar_url: true,
    is_approved: true,
    workspace_id: true,
    created_at: true,
    updated_at: true,
    last_login_at: true,
    password_hash: true,
  } }) as unknown as UserQueryRow | null
  if (!row) {
    // Always run verifyPassword to prevent timing-based username enumeration
    verifyPassword(password, DUMMY_HASH)
    try { await logSecurityEvent({ event_type: 'auth_failure', severity: 'warning', source: 'auth', detail: JSON.stringify({ username, reason: 'user_not_found' }), workspace_id: 1, tenant_id: 1 }) } catch {}
    return null
  }
  if ((row.provider || 'local') !== 'local') {
    verifyPassword(password, DUMMY_HASH)
    try { await logSecurityEvent({ event_type: 'auth_failure', severity: 'warning', source: 'auth', detail: JSON.stringify({ username, reason: 'wrong_provider' }), workspace_id: 1, tenant_id: 1 }) } catch {}
    return null
  }
  if ((row.is_approved ?? 1) !== 1) {
    verifyPassword(password, DUMMY_HASH)
    try { await logSecurityEvent({ event_type: 'auth_failure', severity: 'warning', source: 'auth', detail: JSON.stringify({ username, reason: 'not_approved' }), workspace_id: 1, tenant_id: 1 }) } catch {}
    return null
  }
  if (!verifyPassword(password, row.password_hash)) {
    try { await logSecurityEvent({ event_type: 'auth_failure', severity: 'warning', source: 'auth', detail: JSON.stringify({ username, reason: 'invalid_password' }), workspace_id: 1, tenant_id: 1 }) } catch {}
    return null
  }
  const defaultCtx = await getDefaultWorkspaceContext()
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    workspace_id: row.workspace_id || defaultCtx.workspaceId,
    tenant_id: await resolveTenantForWorkspace(row.workspace_id || defaultCtx.workspaceId),
    provider: row.provider || 'local',
    email: row.email ?? null,
    avatar_url: row.avatar_url ?? null,
    is_approved: row.is_approved ?? 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
  }
}

export async function getUserById(id: number): Promise<User | null> {
  const prisma = getPrismaClient()
  const row = await prisma.users.findUnique({
    where: { id },
    select: {
      id: true,
      username: true,
      display_name: true,
      role: true,
      workspace_id: true,
      provider: true,
      email: true,
      avatar_url: true,
      is_approved: true,
      created_at: true,
      updated_at: true,
      last_login_at: true,
    },
  })
  if (!row) return null
  const defaultCtx = await getDefaultWorkspaceContext()
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role as User['role'],
    workspace_id: row.workspace_id || defaultCtx.workspaceId,
    tenant_id: await resolveTenantForWorkspace(row.workspace_id || defaultCtx.workspaceId),
    provider: (row.provider as User['provider']) || 'local',
    email: row.email ?? null,
    avatar_url: row.avatar_url ?? null,
    is_approved: row.is_approved ?? 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at ?? null,
  }
}

export async function getAllUsers(): Promise<User[]> {
  const prisma = getPrismaClient()
  const rows = await prisma.users.findMany({
    orderBy: { created_at: 'asc' },
  })
  const defaultCtx = await getDefaultWorkspaceContext()
  const tenantCache = new Map<number, number>()
  const resolveTenantCached = async (workspaceId: number) => {
    if (tenantCache.has(workspaceId)) return tenantCache.get(workspaceId)!
    const tenantId = await resolveTenantForWorkspace(workspaceId)
    tenantCache.set(workspaceId, tenantId)
    return tenantId
  }

  return Promise.all(rows.map(async (row) => ({
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role as User['role'],
    workspace_id: row.workspace_id || defaultCtx.workspaceId,
    tenant_id: await resolveTenantCached(row.workspace_id || defaultCtx.workspaceId),
    provider: (row.provider as User['provider']) || 'local',
    email: row.email ?? null,
    avatar_url: row.avatar_url ?? null,
    is_approved: row.is_approved ?? 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at ?? null,
  })))
}

export async function createUser(
  username: string,
  password: string,
  displayName: string,
  role: User['role'] = 'operator',
  options?: { provider?: 'local' | 'google'; provider_user_id?: string | null; email?: string | null; avatar_url?: string | null; is_approved?: 0 | 1; approved_by?: string | null; approved_at?: number | null; workspace_id?: number }
): Promise<User> {
  const prisma = getPrismaClient()
  if (password.length < 12) throw new Error('Password must be at least 12 characters')
  const passwordHash = hashPassword(password)
  const provider = options?.provider || 'local'
  const defaultCtx = await getDefaultWorkspaceContext()
  const now = Math.floor(Date.now() / 1000)
  const workspaceId = options?.workspace_id || defaultCtx.workspaceId

  const created = await prisma.users.create({
    data: {
      username,
      display_name: displayName,
      password_hash: passwordHash,
      role,
      provider,
      provider_user_id: options?.provider_user_id || null,
      email: options?.email || null,
      avatar_url: options?.avatar_url || null,
      is_approved: typeof options?.is_approved === 'number' ? options.is_approved : 1,
      approved_by: options?.approved_by || null,
      approved_at: options?.approved_at || null,
      workspace_id: workspaceId,
      created_at: now,
      updated_at: now,
    },
  })

  return (await getUserById(created.id))!
}

export async function updateUser(id: number, updates: { display_name?: string; role?: User['role']; password?: string; email?: string | null; avatar_url?: string | null; is_approved?: 0 | 1 }): Promise<User | null> {
  const prisma = getPrismaClient()
  const data: any = {}

  if (updates.display_name !== undefined) data.display_name = updates.display_name
  if (updates.role !== undefined) data.role = updates.role
  if (updates.password !== undefined) data.password_hash = hashPassword(updates.password)
  if (updates.email !== undefined) data.email = updates.email
  if (updates.avatar_url !== undefined) data.avatar_url = updates.avatar_url
  if (updates.is_approved !== undefined) data.is_approved = updates.is_approved

  if (Object.keys(data).length === 0) return getUserById(id)
  data.updated_at = Math.floor(Date.now() / 1000)

  await prisma.users.update({ where: { id }, data, select: { id: true } })
  return getUserById(id)
}

export async function deleteUser(id: number): Promise<boolean> {
  const prisma = getPrismaClient()
  await destroyAllUserSessions(id)
  const result = await prisma.users.deleteMany({ where: { id } })
  return result.count > 0
}

/**
 * Seed admin user from environment variables on first run.
 * If no users exist, creates an admin from AUTH_USER/AUTH_PASS env vars.
 */
/**
 * Get user from request - checks session cookie or API key.
 * For API key auth, returns a synthetic "api" user.
 */
/**
 * Resolve a user by username for proxy auth.
 * If the user does not exist and MC_PROXY_AUTH_DEFAULT_ROLE is set, auto-provisions them.
 * Auto-provisioned users receive a random unusable password — they cannot log in locally.
 */
async function resolveOrProvisionProxyUserAsync(username: string): Promise<User | null> {
  try {
    const prisma = getPrismaClient()
    const defaultCtx = await getDefaultWorkspaceContext()

    const row = await prisma.users.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        display_name: true,
        role: true,
        workspace_id: true,
        provider: true,
        email: true,
        avatar_url: true,
        is_approved: true,
        created_at: true,
        updated_at: true,
        last_login_at: true,
      },
    })

    if (row) {
      if ((row.is_approved ?? 1) !== 1) return null
      const workspaceId = row.workspace_id || defaultCtx.workspaceId
      return {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        role: row.role as User['role'],
        workspace_id: workspaceId,
        tenant_id: await resolveTenantForWorkspace(workspaceId),
        provider: (row.provider as User['provider']) || 'local',
        email: row.email ?? null,
        avatar_url: row.avatar_url ?? null,
        is_approved: row.is_approved ?? 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_login_at: row.last_login_at ?? null,
      }
    }

    const defaultRole = (process.env.MC_PROXY_AUTH_DEFAULT_ROLE || '').trim()
    if (!defaultRole || !(['viewer', 'operator', 'admin'] as const).includes(defaultRole as User['role'])) {
      return null
    }

    return createUser(username, randomBytes(32).toString('hex'), username, defaultRole as User['role'])
  } catch {
    return null
  }
}

export async function getUserFromRequest(request: Request): Promise<User | null> {
  // Extract agent identity header (optional, for attribution)
  const agentName = (request.headers.get('x-agent-name') || '').trim() || null

  // Proxy / trusted-header auth (MC_PROXY_AUTH_HEADER)
  // When the gateway has already authenticated the user and injects their username
  // as a trusted header (e.g. X-Auth-Username from Envoy OIDC claimToHeaders),
  // skip the local login form entirely.
  const proxyAuthHeader = (process.env.MC_PROXY_AUTH_HEADER || '').trim()
  if (proxyAuthHeader) {
    const proxyUsername = (request.headers.get(proxyAuthHeader) || '').trim()
    if (proxyUsername) {
      const user = await resolveOrProvisionProxyUserAsync(proxyUsername)
      if (user) return { ...user, agent_name: agentName }
    }
  }

  // Check session cookie
  const cookieHeader = request.headers.get('cookie') || ''
  const sessionToken = parseMcSessionCookieHeader(cookieHeader)
  if (sessionToken) {
    const user = await validateSession(sessionToken)
    if (user) return { ...user, agent_name: agentName }
  }

  // Check API key - DB override first, then env var
  const apiKey = extractApiKeyFromHeaders(request.headers)
  const configuredApiKey = await resolveActiveApiKey()

  if (configuredApiKey && apiKey && safeCompare(apiKey, configuredApiKey)) {
    const defaultCtx = await getDefaultWorkspaceContext()
    return {
      id: 0,
      username: 'api',
      display_name: 'API Access',
      role: 'admin',
      workspace_id: defaultCtx.workspaceId,
      tenant_id: defaultCtx.tenantId,
      created_at: 0,
      updated_at: 0,
      last_login_at: null,
      agent_name: agentName,
    }
  }

  // Agent-scoped API keys
  if (apiKey) {
    try {
      const prisma = getPrismaClient()
      const keyHash = hashApiKey(apiKey)
      const now = Math.floor(Date.now() / 1000)
      const row = await prisma.agent_api_keys.findFirst({
        where: {
          key_hash: keyHash,
        },
        orderBy: { id: 'asc' },
      })

      if (row && !row.revoked_at && (!row.expires_at || row.expires_at > now)) {
        const scopes = parseAgentScopes(row.scopes)
        const agent = await prisma.agents.findFirst({
          where: { id: row.agent_id, workspace_id: row.workspace_id },
          select: { id: true, name: true },
        })

        if (agent) {
          if (agentName && agentName !== agent.name && !scopes.has('admin')) {
            return null
          }

          await prisma.agent_api_keys.update({
            where: { id: row.id },
            data: { last_used_at: now, updated_at: now },
            select: { id: true },
          })

          return {
            id: -row.id,
            username: `agent:${agent.name}`,
            display_name: agent.name,
            role: deriveRoleFromScopes(scopes),
            workspace_id: row.workspace_id,
            tenant_id: (await getDefaultWorkspaceContext()).tenantId,
            created_at: 0,
            updated_at: now,
            last_login_at: now,
            agent_name: agent.name,
          }
        }
      }
    } catch {
      // ignore missing table / startup race
    }
  }

  // Plugin hook: allow Pro (or other extensions) to resolve custom API keys
  if (apiKey && _authResolverHook) {
    const resolved = await _authResolverHook(apiKey, agentName)
    if (resolved) return resolved
  }

  return null
}

/**
 * Resolve the active API key: check DB settings override first, then env var.
 */
async function resolveActiveApiKey(): Promise<string> {
  try {
    const prisma = getPrismaClient()
    const row = await prisma.settings.findUnique({ where: { key: 'security.api_key' }, select: { value: true } })
    if (row?.value) return row.value
  } catch {
    // DB not ready yet — fall back to env
  }
  return (process.env.API_KEY || '').trim()
}

function extractApiKeyFromHeaders(headers: Headers): string | null {
  const direct = (headers.get('x-api-key') || '').trim()
  if (direct) return direct

  const authorization = (headers.get('authorization') || '').trim()
  if (!authorization) return null

  const [scheme, ...rest] = authorization.split(/\s+/)
  if (!scheme || rest.length === 0) return null

  const normalized = scheme.toLowerCase()
  if (normalized === 'bearer' || normalized === 'apikey' || normalized === 'token') {
    return rest.join(' ').trim() || null
  }

  return null
}

function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

function parseAgentScopes(raw: string): Set<string> {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set(parsed.map((scope) => String(scope)))
  } catch {
    // ignore parse errors
  }
  return new Set()
}

function deriveRoleFromScopes(scopes: Set<string>): User['role'] {
  if (scopes.has('admin')) return 'admin'
  if (scopes.has('operator')) return 'operator'
  return 'viewer'
}

/**
 * Role hierarchy levels for access control.
 * viewer < operator < admin
 */
const ROLE_LEVELS: Record<string, number> = { viewer: 0, operator: 1, admin: 2 }

/**
 * Check if a user meets the minimum role requirement.
 * Returns { user } on success, or { error, status } on failure (401 or 403).
 */
export function requireRole(
  request: Request,
  minRole: User['role']
): Promise<{ user: User; error?: never; status?: never } | { user?: never; error: string; status: 401 | 403 }> {
  return requireRoleAsync(request, minRole)
}

async function requireRoleAsync(
  request: Request,
  minRole: User['role']
): Promise<{ user: User; error?: never; status?: never } | { user?: never; error: string; status: 401 | 403 }> {
  const user = await getUserFromRequest(request)
  if (!user) return { error: 'Authentication required', status: 401 }
  if ((ROLE_LEVELS[user.role] ?? -1) < ROLE_LEVELS[minRole]) {
    return { error: `Requires ${minRole} role or higher`, status: 403 }
  }
  return { user }
}
