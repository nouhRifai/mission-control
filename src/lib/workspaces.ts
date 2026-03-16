import type Database from 'better-sqlite3'
import { getPrismaClient } from '@/lib/prisma'

export interface WorkspaceRecord {
  id: number
  slug: string
  name: string
  tenant_id: number
  created_at: number
  updated_at: number
}

export interface ProjectTenantRecord {
  id: number
  workspace_id: number
  tenant_id: number
}

export class ForbiddenError extends Error {
  readonly status = 403 as const
  constructor(message: string) {
    super(message)
    this.name = 'ForbiddenError'
  }
}

interface AccessAuditContext {
  actor?: string
  actorId?: number
  route?: string
  ipAddress?: string | null
  userAgent?: string | null
}

function logTenantAccessDenied(
  db: Database.Database,
  targetType: 'workspace' | 'project',
  targetId: number,
  tenantId: number,
  context: AccessAuditContext
) {
  db.prepare(`
    INSERT INTO audit_log (action, actor, actor_id, target_type, target_id, detail, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'tenant_access_denied',
    context.actor || 'unknown',
    context.actorId ?? null,
    targetType,
    targetId,
    JSON.stringify({
      tenant_id: tenantId,
      route: context.route || null,
    }),
    context.ipAddress ?? null,
    context.userAgent ?? null
  )
}

function logTenantAccessDeniedAsync(
  targetType: 'workspace' | 'project',
  targetId: number,
  tenantId: number,
  context: AccessAuditContext
) {
  const prisma = getPrismaClient()
  const now = Math.floor(Date.now() / 1000)
  void prisma.audit_log.create({
    data: {
      action: 'tenant_access_denied',
      actor: context.actor || 'unknown',
      actor_id: context.actorId ?? null,
      target_type: targetType,
      target_id: targetId,
      detail: JSON.stringify({
        tenant_id: tenantId,
        route: context.route || null,
      }),
      ip_address: context.ipAddress ?? null,
      user_agent: context.userAgent ?? null,
      created_at: now,
    },
    select: { id: true },
  }).catch(() => {
    // best-effort
  })
}

export function getWorkspaceForTenant(
  db: Database.Database,
  workspaceId: number,
  tenantId: number
): WorkspaceRecord | null {
  const row = db.prepare(`
    SELECT id, slug, name, tenant_id, created_at, updated_at
    FROM workspaces
    WHERE id = ? AND tenant_id = ?
    LIMIT 1
  `).get(workspaceId, tenantId) as WorkspaceRecord | undefined
  return row || null
}

export function listWorkspacesForTenant(
  db: Database.Database,
  tenantId: number
): WorkspaceRecord[] {
  return db.prepare(`
    SELECT id, slug, name, tenant_id, created_at, updated_at
    FROM workspaces
    WHERE tenant_id = ?
    ORDER BY CASE WHEN slug = 'default' THEN 0 ELSE 1 END, name COLLATE NOCASE ASC
  `).all(tenantId) as WorkspaceRecord[]
}

export async function getWorkspaceForTenantAsync(
  workspaceId: number,
  tenantId: number
): Promise<WorkspaceRecord | null> {
  const prisma = getPrismaClient()
  const row = await prisma.workspaces.findFirst({
    where: { id: workspaceId, tenant_id: tenantId },
    select: { id: true, slug: true, name: true, tenant_id: true, created_at: true, updated_at: true },
  })
  return (row as any) || null
}

export async function listWorkspacesForTenantAsync(
  tenantId: number
): Promise<WorkspaceRecord[]> {
  const prisma = getPrismaClient()
  const rows = await prisma.workspaces.findMany({
    where: { tenant_id: tenantId },
    select: { id: true, slug: true, name: true, tenant_id: true, created_at: true, updated_at: true },
  })

  // Match legacy ordering: default first, then name case-insensitively.
  return [...(rows as any[])].sort((a, b) => {
    const aIsDefault = a.slug === 'default'
    const bIsDefault = b.slug === 'default'
    if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1
    return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' })
  }) as WorkspaceRecord[]
}

export function assertWorkspaceTenant(
  db: Database.Database,
  workspaceId: number,
  tenantId: number
): WorkspaceRecord {
  const workspace = getWorkspaceForTenant(db, workspaceId, tenantId)
  if (!workspace) {
    throw new Error('Workspace not found for tenant')
  }
  return workspace
}

export function ensureTenantWorkspaceAccess(
  db: Database.Database,
  tenantId: number,
  workspaceId: number,
  context: AccessAuditContext = {}
): WorkspaceRecord {
  const workspace = getWorkspaceForTenant(db, workspaceId, tenantId)
  if (!workspace) {
    logTenantAccessDenied(db, 'workspace', workspaceId, tenantId, context)
    throw new ForbiddenError('Workspace not accessible for tenant')
  }
  return workspace
}

export async function ensureTenantWorkspaceAccessAsync(
  tenantId: number,
  workspaceId: number,
  context: AccessAuditContext = {}
): Promise<WorkspaceRecord> {
  const workspace = await getWorkspaceForTenantAsync(workspaceId, tenantId)
  if (!workspace) {
    logTenantAccessDeniedAsync('workspace', workspaceId, tenantId, context)
    throw new ForbiddenError('Workspace not accessible for tenant')
  }
  return workspace
}

export function ensureTenantProjectAccess(
  db: Database.Database,
  tenantId: number,
  projectId: number,
  context: AccessAuditContext = {}
): ProjectTenantRecord {
  const project = db.prepare(`
    SELECT p.id, p.workspace_id, w.tenant_id
    FROM projects p
    JOIN workspaces w ON w.id = p.workspace_id
    WHERE p.id = ?
    LIMIT 1
  `).get(projectId) as ProjectTenantRecord | undefined

  if (!project || project.tenant_id !== tenantId) {
    logTenantAccessDenied(db, 'project', projectId, tenantId, context)
    throw new ForbiddenError('Project not accessible for tenant')
  }

  return project
}

export async function ensureTenantProjectAccessAsync(
  tenantId: number,
  projectId: number,
  context: AccessAuditContext = {}
): Promise<ProjectTenantRecord> {
  const prisma = getPrismaClient()
  const project = await prisma.projects.findFirst({
    where: { id: projectId },
    select: { id: true, workspace_id: true },
  })

  const tenantRow = project
    ? await prisma.workspaces.findUnique({
        where: { id: project.workspace_id },
        select: { tenant_id: true },
      })
    : null

  const resolved: ProjectTenantRecord | null = project && tenantRow
    ? { id: project.id, workspace_id: project.workspace_id, tenant_id: tenantRow.tenant_id }
    : null

  if (!resolved || resolved.tenant_id !== tenantId) {
    logTenantAccessDeniedAsync('project', projectId, tenantId, context)
    throw new ForbiddenError('Project not accessible for tenant')
  }

  return resolved
}
