import { NextRequest, NextResponse } from 'next/server';
import { db_helpers } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { config } from '@/lib/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { resolveWithin } from '@/lib/paths';
import { getAgentWorkspaceCandidates, readAgentWorkspaceFile } from '@/lib/agent-workspace';
import { getPrismaClient } from '@/lib/prisma';

function resolveAgentWorkspacePath(workspace: string): string {
  if (isAbsolute(workspace)) return resolve(workspace)
  if (!config.openclawStateDir) throw new Error('OPENCLAW_STATE_DIR not configured')
  return resolveWithin(config.openclawStateDir, workspace)
}

/**
 * GET /api/agents/[id]/memory - Get agent's working memory
 * 
 * Working memory is stored in the agents.working_memory DB column.
 * This endpoint is per-agent scratchpad memory (not the global Memory Browser filesystem view).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'viewer');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const prisma = getPrismaClient();
    const resolvedParams = await params;
    const agentId = resolvedParams.id;
    const workspaceId = auth.user.workspace_id ?? 1;
    
    // Get agent by ID or name
    let agent: any;
    if (isNaN(Number(agentId))) {
      agent = await prisma.agents.findFirst({
        where: { name: agentId, workspace_id: workspaceId },
      });
    } else {
      agent = await prisma.agents.findFirst({
        where: { id: Number(agentId), workspace_id: workspaceId },
      });
    }
    
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    
    // Prefer workspace WORKING.md, fall back to DB working_memory
    let workingMemory = '';
    let source: 'workspace' | 'database' | 'none' = 'none';
    try {
      const agentConfig = agent.config ? JSON.parse(agent.config) : {};
      const candidates = getAgentWorkspaceCandidates(agentConfig, agent.name);
      const match = readAgentWorkspaceFile(candidates, ['WORKING.md', 'working.md', 'MEMORY.md', 'memory.md']);
      if (match.exists) {
        workingMemory = match.content;
        source = 'workspace';
      }
    } catch (err) {
      logger.warn({ err, agent: agent.name }, 'Failed to read WORKING.md from workspace');
    }

    // Get working memory content
    if (!workingMemory) {
      workingMemory = agent.working_memory || '';
      source = workingMemory ? 'database' : 'none';
    }
    
    return NextResponse.json({
      agent: {
        id: agent.id,
        name: agent.name,
        role: agent.role
      },
      working_memory: workingMemory,
      source,
      updated_at: agent.updated_at,
      size: workingMemory.length
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/[id]/memory error');
    return NextResponse.json({ error: 'Failed to fetch working memory' }, { status: 500 });
  }
}

/**
 * PUT /api/agents/[id]/memory - Update agent's working memory
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const prisma = getPrismaClient();
    const resolvedParams = await params;
    const agentId = resolvedParams.id;
    const workspaceId = auth.user.workspace_id ?? 1;
    const body = await request.json();
    const { working_memory, append } = body;
    
    // Get agent by ID or name
    let agent: any;
    if (isNaN(Number(agentId))) {
      agent = await prisma.agents.findFirst({
        where: { name: agentId, workspace_id: workspaceId },
      });
    } else {
      agent = await prisma.agents.findFirst({
        where: { id: Number(agentId), workspace_id: workspaceId },
      });
    }
    
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    
    let newContent = working_memory || '';
    
    // Handle append mode
    if (append) {
      const currentContent = agent.working_memory || '';
      
      // Add timestamp and append
      const timestamp = new Date().toISOString();
      newContent = currentContent + (currentContent ? '\n\n' : '') + 
                   `## ${timestamp}\n${working_memory}`;
    }
    
    const now = Math.floor(Date.now() / 1000);

    // Best effort: sync workspace WORKING.md if agent workspace is configured
    let savedToWorkspace = false;
    try {
      const agentConfig = agent.config ? JSON.parse(agent.config) : {};
      const candidates = getAgentWorkspaceCandidates(agentConfig, agent.name);
      const safeWorkspace = candidates[0];
      if (safeWorkspace) {
        const safeWorkingPath = resolveWithin(safeWorkspace, 'WORKING.md');
        mkdirSync(dirname(safeWorkingPath), { recursive: true });
        writeFileSync(safeWorkingPath, newContent, 'utf-8');
        savedToWorkspace = true;
      }
    } catch (err) {
      logger.warn({ err, agent: agent.name }, 'Failed to write WORKING.md to workspace');
    }
    
    // Update working memory
    await prisma.agents.update({
      where: { id: agent.id },
      data: { working_memory: newContent, updated_at: now },
      select: { id: true },
    });
    
    // Log activity
    db_helpers.logActivity(
      'agent_memory_updated',
      'agent',
      agent.id,
      agent.name,
      `Working memory ${append ? 'appended' : 'updated'} for agent ${agent.name}`,
      {
        content_length: newContent.length,
        append_mode: append || false,
        timestamp: now,
        saved_to_workspace: savedToWorkspace
      },
      workspaceId
    );
    
    return NextResponse.json({
      success: true,
      message: `Working memory ${append ? 'appended' : 'updated'} for ${agent.name}`,
      working_memory: newContent,
      saved_to_workspace: savedToWorkspace,
      updated_at: now,
      size: newContent.length
    });
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/agents/[id]/memory error');
    return NextResponse.json({ error: 'Failed to update working memory' }, { status: 500 });
  }
}

/**
 * DELETE /api/agents/[id]/memory - Clear agent's working memory
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const prisma = getPrismaClient();
    const resolvedParams = await params;
    const agentId = resolvedParams.id;
    const workspaceId = auth.user.workspace_id ?? 1;

    // Get agent by ID or name
    let agent: any;
    if (isNaN(Number(agentId))) {
      agent = await prisma.agents.findFirst({
        where: { name: agentId, workspace_id: workspaceId },
      });
    } else {
      agent = await prisma.agents.findFirst({
        where: { id: Number(agentId), workspace_id: workspaceId },
      });
    }
    
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    
    const now = Math.floor(Date.now() / 1000);

    // Best effort: clear workspace WORKING.md if agent workspace is configured
    try {
      const agentConfig = agent.config ? JSON.parse(agent.config) : {};
      const candidates = getAgentWorkspaceCandidates(agentConfig, agent.name);
      const safeWorkspace = candidates[0];
      if (safeWorkspace) {
        const safeWorkingPath = resolveWithin(safeWorkspace, 'WORKING.md');
        mkdirSync(dirname(safeWorkingPath), { recursive: true });
        writeFileSync(safeWorkingPath, '', 'utf-8');
      }
    } catch (err) {
      logger.warn({ err, agent: agent.name }, 'Failed to clear WORKING.md in workspace');
    }
    
    // Clear working memory
    await prisma.agents.update({
      where: { id: agent.id },
      data: { working_memory: '', updated_at: now },
      select: { id: true },
    });
    
    // Log activity
    db_helpers.logActivity(
      'agent_memory_cleared',
      'agent',
      agent.id,
      agent.name,
      `Working memory cleared for agent ${agent.name}`,
      { timestamp: now },
      workspaceId
    );
    
    return NextResponse.json({
      success: true,
      message: `Working memory cleared for ${agent.name}`,
      working_memory: '',
      updated_at: now
    });
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/agents/[id]/memory error');
    return NextResponse.json({ error: 'Failed to clear working memory' }, { status: 500 });
  }
}
