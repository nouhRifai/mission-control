import { NextRequest, NextResponse } from 'next/server';
import { Agent, db_helpers, logAuditEvent } from '@/lib/db';
import { eventBus } from '@/lib/event-bus';
import { getTemplate, buildAgentConfig } from '@/lib/agent-templates';
import { writeAgentToConfig, enrichAgentConfigFromWorkspace } from '@/lib/agent-sync';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { validateBody, createAgentSchema } from '@/lib/validation';
import { runOpenClaw } from '@/lib/command';
import { config as appConfig } from '@/lib/config';
import { resolveWithin } from '@/lib/paths';
import path from 'node:path';
import { getPrismaClient } from '@/lib/prisma';
import { Prisma } from '@/generated/prisma/sqlite';

/**
 * GET /api/agents - List all agents with optional filtering
 * Query params: status, role, limit, offset
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient();
    const { searchParams } = new URL(request.url);
    const workspaceId = auth.user.workspace_id ?? 1;
    
    // Parse query parameters
    const status = searchParams.get('status');
    const role = searchParams.get('role');
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
    const offset = parseInt(searchParams.get('offset') || '0');
    
    const where: any = {
      workspace_id: workspaceId,
      ...(status ? { status } : {}),
      ...(role ? { role } : {}),
    }

    const [agents, total] = await Promise.all([
      prisma.agents.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.agents.count({ where }),
    ])
    
    // Parse JSON config field
    const agentsWithParsedData = (agents as any[]).map((agent) => ({
      ...agent,
      config: enrichAgentConfigFromWorkspace(agent.config ? JSON.parse(agent.config) : {}),
    }));
    
    // Get task counts for all listed agents in one query (avoids N+1 queries)
    const agentNames = agentsWithParsedData.map(agent => agent.name).filter(Boolean)
    const taskStatsByAgent = new Map<string, { total: number; assigned: number; in_progress: number; quality_review: number; done: number }>()

    if (agentNames.length > 0) {
      const groupedTaskStats = await prisma.$queryRaw<any[]>`
        SELECT
          assigned_to,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) as assigned,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
          SUM(CASE WHEN status = 'quality_review' THEN 1 ELSE 0 END) as quality_review,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
        FROM tasks
        WHERE workspace_id = ${workspaceId} AND assigned_to IN (${Prisma.join(agentNames)})
        GROUP BY assigned_to
      `

      const toNum = (v: any) => (typeof v === 'bigint' ? Number(v) : (Number.isFinite(Number(v)) ? Number(v) : 0))
      for (const row of groupedTaskStats) {
        taskStatsByAgent.set(String(row.assigned_to), {
          total: toNum(row.total),
          assigned: toNum(row.assigned),
          in_progress: toNum(row.in_progress),
          quality_review: toNum(row.quality_review),
          done: toNum(row.done),
        })
      }
    }

    const agentsWithStats = agentsWithParsedData.map(agent => {
      const taskStats = taskStatsByAgent.get(agent.name) || {
        total: 0,
        assigned: 0,
        in_progress: 0,
        quality_review: 0,
        done: 0,
      }

      return {
        ...agent,
        taskStats: {
          ...taskStats,
          completed: taskStats.done,
        }
      };
    });
    
    return NextResponse.json({
      agents: agentsWithStats,
      total,
      page: Math.floor(offset / limit) + 1,
      limit
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents error');
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 });
  }
}

/**
 * POST /api/agents - Create a new agent
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const prisma = getPrismaClient();
    const workspaceId = auth.user.workspace_id ?? 1;
    const validated = await validateBody(request, createAgentSchema);
    if ('error' in validated) return validated.error;
    const body = validated.data;

    const {
      name,
      openclaw_id,
      role,
      session_key,
      soul_content,
      status = 'offline',
      config = {},
      template,
      gateway_config,
      write_to_gateway,
      provision_openclaw_workspace,
      openclaw_workspace_path
    } = body;

    const openclawId = (openclaw_id || name || 'agent')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Resolve template if specified
    let finalRole = role;
    let finalConfig: Record<string, any> = { ...config };
    if (template) {
      const tpl = getTemplate(template);
      if (tpl) {
        const builtConfig = buildAgentConfig(tpl, (gateway_config || {}) as any);
        finalConfig = { ...builtConfig, ...finalConfig };
        if (!finalRole) finalRole = tpl.config.identity?.theme || tpl.type;
      }
    } else if (gateway_config) {
      finalConfig = { ...finalConfig, ...(gateway_config as Record<string, any>) };
    }

    if (!name || !finalRole) {
      return NextResponse.json({ error: 'Name and role are required' }, { status: 400 });
    }

    // Check if agent name already exists
    const existingAgent = await prisma.agents.findFirst({
      where: { name, workspace_id: workspaceId },
      select: { id: true },
    })
    if (existingAgent) {
      return NextResponse.json({ error: 'Agent name already exists' }, { status: 409 });
    }

    if (provision_openclaw_workspace) {
      if (!appConfig.openclawStateDir) {
        return NextResponse.json(
          { error: 'OPENCLAW_STATE_DIR is not configured; cannot provision OpenClaw workspace' },
          { status: 500 }
        );
      }

      const workspacePath = openclaw_workspace_path
        ? path.resolve(openclaw_workspace_path)
        : resolveWithin(appConfig.openclawStateDir, path.join('workspaces', openclawId));

      try {
        await runOpenClaw(
          ['agents', 'add', openclawId, '--workspace', workspacePath, '--non-interactive'],
          { timeoutMs: 20000 }
        );
      } catch (provisionError: any) {
        logger.error({ err: provisionError, openclawId, workspacePath }, 'OpenClaw workspace provisioning failed');
        return NextResponse.json(
          { error: provisionError?.message || 'Failed to provision OpenClaw agent workspace' },
          { status: 502 }
        );
      }
    }
    
    const now = Math.floor(Date.now() / 1000);
    const created = await prisma.agents.create({
      data: {
        name,
        role: finalRole,
        session_key: session_key ?? null,
        soul_content: soul_content ?? null,
        status,
        created_at: now,
        updated_at: now,
        config: JSON.stringify(finalConfig),
        workspace_id: workspaceId,
      } as any,
      select: { id: true },
    })
    const agentId = created.id
    
    // Log activity
    db_helpers.logActivity(
      'agent_created',
      'agent',
      agentId,
      auth.user.username,
      `Created agent: ${name} (${finalRole})${template ? ` from template: ${template}` : ''}`,
      {
        name,
        role: finalRole,
        status,
        session_key,
        template: template || null
      },
      workspaceId
    );
    
    // Fetch the created agent
    const createdAgent = await prisma.agents.findFirst({
      where: { id: agentId, workspace_id: workspaceId },
    }) as unknown as Agent | null
    if (!createdAgent) throw new Error('Agent not found after create')
    const parsedAgent = {
      ...(createdAgent as any),
      config: JSON.parse((createdAgent as any).config || '{}'),
      taskStats: { total: 0, assigned: 0, in_progress: 0, quality_review: 0, done: 0, completed: 0 },
    }

    // Broadcast to SSE clients
    eventBus.broadcast('agent.created', parsedAgent);

    // Write to gateway config if requested
    if (write_to_gateway && finalConfig) {
      try {
        await writeAgentToConfig({
          id: openclawId,
          name,
          ...(finalConfig.model && { model: finalConfig.model }),
          ...(finalConfig.identity && { identity: finalConfig.identity }),
          ...(finalConfig.sandbox && { sandbox: finalConfig.sandbox }),
          ...(finalConfig.tools && { tools: finalConfig.tools }),
          ...(finalConfig.subagents && { subagents: finalConfig.subagents }),
          ...(finalConfig.memorySearch && { memorySearch: finalConfig.memorySearch }),
        });

        const ipAddress = request.headers.get('x-forwarded-for') || 'unknown';
        logAuditEvent({
          action: 'agent_gateway_create',
          actor: auth.user.username,
          actor_id: auth.user.id,
          target_type: 'agent',
          target_id: agentId as number,
          detail: { name, openclaw_id: openclawId, template: template || null },
          ip_address: ipAddress,
        });
      } catch (gwErr: any) {
        logger.error({ err: gwErr }, 'Gateway write-back failed');
        return NextResponse.json({ 
          agent: parsedAgent,
          warning: `Agent created in MC but gateway write failed: ${gwErr.message}`
        }, { status: 201 });
      }
    }

    return NextResponse.json({ agent: parsedAgent }, { status: 201 });
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents error');
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
}

/**
 * PUT /api/agents - Update agent status (bulk operation for status updates)
 */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const prisma = getPrismaClient();
    const workspaceId = auth.user.workspace_id ?? 1;
    const body = await request.json();

    // Handle single agent update or bulk updates
    if (body.name) {
      // Single agent update
      const { name, status, last_activity, config, session_key, soul_content, role } = body;
      
      const agent = await prisma.agents.findFirst({
        where: { name, workspace_id: workspaceId },
      }) as unknown as Agent | null
      if (!agent) {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      const data: any = { updated_at: now }
      if (status !== undefined) {
        data.status = status
        data.last_seen = now
      }
      
      if (last_activity !== undefined) {
        data.last_activity = last_activity
      }
      
      if (config !== undefined) {
        data.config = JSON.stringify(config)
      }
      
      if (session_key !== undefined) {
        data.session_key = session_key
      }
      
      if (soul_content !== undefined) {
        data.soul_content = soul_content
      }
      
      if (role !== undefined) {
        data.role = role
      }

      if (Object.keys(data).length === 1) { // Only updated_at
        return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
      }
      await prisma.agents.updateMany({
        where: { name, workspace_id: workspaceId },
        data,
      })
      
      // Log status change if status was updated
      if (status !== undefined && status !== agent.status) {
        db_helpers.logActivity(
          'agent_status_change',
          'agent',
          agent.id,
          name,
          `Agent status changed from ${agent.status} to ${status}`,
          {
            oldStatus: agent.status,
            newStatus: status,
            last_activity
          },
          workspaceId
        );
      }

      // Broadcast update to SSE clients
      eventBus.broadcast('agent.updated', {
        id: agent.id,
        name,
        ...(status !== undefined && { status }),
        ...(last_activity !== undefined && { last_activity }),
        ...(role !== undefined && { role }),
        updated_at: now,
      });

      return NextResponse.json({ success: true });
    } else {
      return NextResponse.json({ error: 'Agent name is required' }, { status: 400 });
    }
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/agents error');
    return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 });
  }
}
