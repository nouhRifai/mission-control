import { NextRequest, NextResponse } from 'next/server'
import { db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { validateBody, connectSchema } from '@/lib/validation'
import { eventBus } from '@/lib/event-bus'
import { randomUUID } from 'crypto'
import { getPrismaClient } from '@/lib/prisma'

/**
 * POST /api/connect — Register a direct CLI connection
 *
 * Auto-creates agent if name doesn't exist, deactivates previous connections
 * for the same agent, and returns connection details + helper URLs.
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const validation = await validateBody(request, connectSchema)
  if ('error' in validation) return validation.error

  const { tool_name, tool_version, agent_name, agent_role, metadata } = validation.data
  const prisma = getPrismaClient()
  const now = Math.floor(Date.now() / 1000)
  const workspaceId = auth.user.workspace_id ?? 1;

  // Find or create agent
  let agent = await prisma.agents.findFirst({
    where: { name: agent_name, workspace_id: workspaceId },
  }) as any
  if (!agent) {
    agent = await prisma.agents.create({
      data: {
        name: agent_name,
        role: agent_role || 'cli',
        status: 'online',
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
      } as any,
    })
    db_helpers.logActivity('agent_created', 'agent', agent.id as number, 'system',
      `Auto-created agent "${agent_name}" via direct CLI connection`, undefined, workspaceId)
    eventBus.broadcast('agent.created', { id: agent.id, name: agent_name })
  } else {
    // Set agent online
    await prisma.agents.updateMany({
      where: { id: agent.id, workspace_id: workspaceId },
      data: { status: 'online', updated_at: now } as any,
    })
    eventBus.broadcast('agent.status_changed', { id: agent.id, name: agent.name, status: 'online' })
  }

  // Deactivate previous connections for this agent
  await prisma.direct_connections.updateMany({
    where: { agent_id: agent.id, status: 'connected' },
    data: { status: 'disconnected', updated_at: now } as any,
  })

  // Create new connection
  const connectionId = randomUUID()
  await prisma.direct_connections.create({
    data: {
      agent_id: agent.id,
      tool_name,
      tool_version: tool_version || null,
      connection_id: connectionId,
      status: 'connected',
      last_heartbeat: now,
      metadata: metadata ? JSON.stringify(metadata) : null,
      created_at: now,
      updated_at: now,
      workspace_id: workspaceId,
    } as any,
    select: { id: true },
  })

  db_helpers.logActivity('connection_created', 'agent', agent.id as number, agent_name,
    `CLI connection established via ${tool_name}${tool_version ? ` v${tool_version}` : ''}`, undefined, workspaceId)

  eventBus.broadcast('connection.created', {
    connection_id: connectionId,
    agent_id: agent.id,
    agent_name,
    tool_name,
  })

  return NextResponse.json({
    connection_id: connectionId,
    agent_id: agent.id,
    agent_name,
    status: 'connected',
    sse_url: `/api/events`,
    heartbeat_url: `/api/agents/${agent.id}/heartbeat`,
    token_report_url: `/api/tokens`,
  })
}

/**
 * GET /api/connect — List all direct connections
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const prisma = getPrismaClient()
  const workspaceId = auth.user.workspace_id ?? 1;
  const connections = await prisma.direct_connections.findMany({
    where: { workspace_id: workspaceId },
    include: {
      agents: { select: { name: true, status: true, role: true, workspace_id: true } },
    },
    orderBy: { created_at: 'desc' },
  })

  return NextResponse.json({
    connections: (connections as any[]).map((dc) => ({
      ...dc,
      agent_name: dc.agents?.name,
      agent_status: dc.agents?.status,
      agent_role: dc.agents?.role,
    })),
  })
}

/**
 * DELETE /api/connect — Disconnect by connection_id
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { connection_id } = body
  if (!connection_id) {
    return NextResponse.json({ error: 'connection_id is required' }, { status: 400 })
  }

  const prisma = getPrismaClient()
  const now = Math.floor(Date.now() / 1000)
  const workspaceId = auth.user.workspace_id ?? 1;

  const conn = await prisma.direct_connections.findFirst({
    where: { connection_id, workspace_id: workspaceId },
    include: { agents: { select: { id: true, name: true, workspace_id: true } } },
  }) as any
  if (!conn) {
    return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
  }

  await prisma.direct_connections.updateMany({
    where: { connection_id, workspace_id: workspaceId },
    data: { status: 'disconnected', updated_at: now } as any,
  })

  // Check if agent has other active connections; if not, set offline
  const otherActiveCount = await prisma.direct_connections.count({
    where: { agent_id: conn.agent_id, status: 'connected', connection_id: { not: connection_id } },
  })
  if (!otherActiveCount) {
    await prisma.agents.updateMany({
      where: { id: conn.agent_id, workspace_id: workspaceId },
      data: { status: 'offline', updated_at: now } as any,
    })
  }

  const agentName = conn.agents?.name || 'unknown'
  db_helpers.logActivity('connection_disconnected', 'agent', conn.agent_id, agentName,
    `CLI connection disconnected (${conn.tool_name})`, undefined, workspaceId)

  eventBus.broadcast('connection.disconnected', {
    connection_id,
    agent_id: conn.agent_id,
    agent_name: agentName,
  })

  return NextResponse.json({ status: 'disconnected', connection_id })
}
