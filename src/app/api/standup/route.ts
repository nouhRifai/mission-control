import { NextRequest, NextResponse } from 'next/server';
import { db_helpers } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { getPrismaClient } from '@/lib/prisma';
import { Prisma } from '@/generated/prisma/sqlite';

/**
 * POST /api/standup/generate - Generate daily standup report
 * Body: { date?: string, agents?: string[] }
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const prisma = getPrismaClient();
    const body = await request.json();
    const workspaceId = auth.user.workspace_id ?? 1;
    
    // Parse parameters
    const targetDate = body.date || new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    const specificAgents = body.agents; // Optional filter for specific agents
    
    // Calculate time range for "today" (start and end of the target date)
    const startOfDay = Math.floor(new Date(`${targetDate}T00:00:00Z`).getTime() / 1000);
    const endOfDay = Math.floor(new Date(`${targetDate}T23:59:59Z`).getTime() / 1000);
    
    const agents = await prisma.agents.findMany({
      where: {
        workspace_id: workspaceId,
        ...(specificAgents && Array.isArray(specificAgents) && specificAgents.length > 0
          ? { name: { in: specificAgents.map((v: any) => String(v)) } }
          : {}),
      } as any,
      orderBy: { name: 'asc' },
      select: { name: true, role: true, status: true, last_seen: true, last_activity: true },
    }) as Array<{ name: string; role: string; status: string; last_seen: number | null; last_activity: string | null }>;

    const agentNames = agents.map((a) => a.name).filter(Boolean);

    const [
      completedTasks,
      inProgressTasks,
      assignedTasks,
      reviewTasks,
      blockedTasks,
      overdueTasks,
      activityCounts,
      commentCounts,
    ] = await Promise.all([
      agentNames.length
        ? prisma.tasks.findMany({
            where: {
              workspace_id: workspaceId,
              assigned_to: { in: agentNames },
              status: 'done',
              updated_at: { gte: startOfDay, lte: endOfDay },
            } as any,
            select: { id: true, title: true, status: true, updated_at: true, assigned_to: true },
            orderBy: { updated_at: 'desc' },
          })
        : Promise.resolve([]),
      agentNames.length
        ? prisma.tasks.findMany({
            where: { workspace_id: workspaceId, assigned_to: { in: agentNames }, status: 'in_progress' } as any,
            select: { id: true, title: true, status: true, created_at: true, due_date: true, assigned_to: true },
            orderBy: { created_at: 'asc' },
          })
        : Promise.resolve([]),
      agentNames.length
        ? prisma.tasks.findMany({
            where: { workspace_id: workspaceId, assigned_to: { in: agentNames }, status: 'assigned' } as any,
            select: { id: true, title: true, status: true, created_at: true, due_date: true, priority: true, assigned_to: true },
            orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
          })
        : Promise.resolve([]),
      agentNames.length
        ? prisma.tasks.findMany({
            where: { workspace_id: workspaceId, assigned_to: { in: agentNames }, status: { in: ['review', 'quality_review'] } } as any,
            select: { id: true, title: true, status: true, updated_at: true, assigned_to: true },
            orderBy: { updated_at: 'asc' },
          })
        : Promise.resolve([]),
      agentNames.length
        ? prisma.tasks.findMany({
            where: {
              workspace_id: workspaceId,
              assigned_to: { in: agentNames },
              status: { notIn: ['done'] },
              OR: [{ priority: 'urgent' }, { metadata: { contains: 'blocked' } }],
            } as any,
            select: { id: true, title: true, status: true, priority: true, created_at: true, metadata: true, assigned_to: true },
            orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
          })
        : Promise.resolve([]),
      prisma.$queryRaw<any[]>`
        SELECT t.*, a.name as agent_name
        FROM tasks t
        LEFT JOIN agents a ON t.assigned_to = a.name
        AND a.workspace_id = t.workspace_id
        WHERE t.due_date < ${Math.floor(Date.now() / 1000)}
        AND t.workspace_id = ${workspaceId}
        AND t.status NOT IN ('done')
        ORDER BY t.due_date ASC
      `,
      agentNames.length
        ? prisma.$queryRaw<any[]>`
            SELECT actor as name, COUNT(*) as count
            FROM activities
            WHERE workspace_id = ${workspaceId}
              AND created_at BETWEEN ${startOfDay} AND ${endOfDay}
              AND actor IN (${Prisma.join(agentNames)})
            GROUP BY actor
          `
        : Promise.resolve([]),
      agentNames.length
        ? prisma.$queryRaw<any[]>`
            SELECT author as name, COUNT(*) as count
            FROM comments
            WHERE workspace_id = ${workspaceId}
              AND created_at BETWEEN ${startOfDay} AND ${endOfDay}
              AND author IN (${Prisma.join(agentNames)})
            GROUP BY author
          `
        : Promise.resolve([]),
    ]);

    const completedByAgent = new Map<string, any[]>();
    for (const t of completedTasks as any[]) {
      const { assigned_to, ...rest } = t as any;
      const key = String(assigned_to || '');
      const list = completedByAgent.get(key) || [];
      list.push(rest);
      completedByAgent.set(key, list);
    }

    const inProgressByAgent = new Map<string, any[]>();
    for (const t of inProgressTasks as any[]) {
      const { assigned_to, ...rest } = t as any;
      const key = String(assigned_to || '');
      const list = inProgressByAgent.get(key) || [];
      list.push(rest);
      inProgressByAgent.set(key, list);
    }

    const assignedByAgent = new Map<string, any[]>();
    for (const t of assignedTasks as any[]) {
      const { assigned_to, ...rest } = t as any;
      const key = String(assigned_to || '');
      const list = assignedByAgent.get(key) || [];
      list.push(rest);
      assignedByAgent.set(key, list);
    }

    const reviewByAgent = new Map<string, any[]>();
    for (const t of reviewTasks as any[]) {
      const { assigned_to, ...rest } = t as any;
      const key = String(assigned_to || '');
      const list = reviewByAgent.get(key) || [];
      list.push(rest);
      reviewByAgent.set(key, list);
    }

    const blockedByAgent = new Map<string, any[]>();
    for (const t of blockedTasks as any[]) {
      const { assigned_to, ...rest } = t as any;
      const key = String(assigned_to || '');
      const list = blockedByAgent.get(key) || [];
      list.push(rest);
      blockedByAgent.set(key, list);
    }

    const activityCountByAgent = new Map<string, number>();
    for (const row of activityCounts as any[]) {
      activityCountByAgent.set(String(row.name), Number(row.count ?? 0));
    }

    const commentCountByAgent = new Map<string, number>();
    for (const row of commentCounts as any[]) {
      commentCountByAgent.set(String(row.name), Number(row.count ?? 0));
    }

    // Generate standup data for each agent
    const standupData = agents.map(agent => {
      const completedToday = completedByAgent.get(agent.name) || [];
      const inProgress = inProgressByAgent.get(agent.name) || [];
      const assigned = assignedByAgent.get(agent.name) || [];
      const review = reviewByAgent.get(agent.name) || [];
      const blocked = blockedByAgent.get(agent.name) || [];

      return {
        agent: {
          name: agent.name,
          role: agent.role,
          status: agent.status,
          last_seen: agent.last_seen,
          last_activity: agent.last_activity
        },
        completedToday,
        inProgress,
        assigned,
        review,
        blocked,
        activity: {
          actionCount: activityCountByAgent.get(agent.name) || 0,
          commentsCount: commentCountByAgent.get(agent.name) || 0
        }
      };
    });
    
    // Generate summary statistics
    const totalCompleted = standupData.reduce((sum, agent) => sum + agent.completedToday.length, 0);
    const totalInProgress = standupData.reduce((sum, agent) => sum + agent.inProgress.length, 0);
    const totalAssigned = standupData.reduce((sum, agent) => sum + agent.assigned.length, 0);
    const totalReview = standupData.reduce((sum, agent) => sum + agent.review.length, 0);
    const totalBlocked = standupData.reduce((sum, agent) => sum + agent.blocked.length, 0);
    const totalActivity = standupData.reduce((sum, agent) => sum + agent.activity.actionCount, 0);
    
    // Identify team accomplishments and blockers
    const teamAccomplishments = standupData
      .flatMap(agent => agent.completedToday.map(task => ({ ...task as any, agent: agent.agent.name })))
      .sort((a: any, b: any) => b.updated_at - a.updated_at);
    
    const teamBlockers = standupData
      .flatMap(agent => agent.blocked.map(task => ({ ...task as any, agent: agent.agent.name })))
      .sort((a: any, b: any) => {
        // Sort by priority then by creation date
        const priorityOrder: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 };
        return (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0) || a.created_at - b.created_at;
      });
    
    const standupReport = {
      date: targetDate,
      generatedAt: new Date().toISOString(),
      summary: {
        totalAgents: agents.length,
        totalCompleted,
        totalInProgress,
        totalAssigned,
        totalReview,
        totalBlocked,
        totalActivity,
        overdue: overdueTasks.length
      },
      agentReports: standupData,
      teamAccomplishments: teamAccomplishments.slice(0, 10), // Top 10 recent completions
      teamBlockers,
      overdueTasks
    };

    // Persist standup report
    const createdAt = Math.floor(Date.now() / 1000);
    await prisma.standup_reports.upsert({
      where: { date: targetDate },
      create: { date: targetDate, report: JSON.stringify(standupReport), created_at: createdAt, workspace_id: workspaceId } as any,
      update: { report: JSON.stringify(standupReport), created_at: createdAt, workspace_id: workspaceId } as any,
    })
    
    // Log the standup generation
    db_helpers.logActivity(
      'standup_generated',
      'standup',
      0, // No specific entity
      auth.user.username,
      `Generated daily standup for ${targetDate}`,
      {
        date: targetDate,
        agentCount: agents.length,
        tasksSummary: {
          completed: totalCompleted,
          inProgress: totalInProgress,
          assigned: totalAssigned,
          review: totalReview,
          blocked: totalBlocked
        }
      },
      workspaceId
    );
    
    return NextResponse.json({ standup: standupReport });
  } catch (error) {
    logger.error({ err: error }, 'POST /api/standup/generate error');
    return NextResponse.json({ error: 'Failed to generate standup' }, { status: 500 });
  }
}

/**
 * GET /api/standup/history - Get previous standup reports
 * Query params: limit, offset
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const prisma = getPrismaClient();
    const { searchParams } = new URL(request.url);
    const workspaceId = auth.user.workspace_id ?? 1;

    const limit = Math.min(parseInt(searchParams.get('limit') || '10'), 200);
    const offset = parseInt(searchParams.get('offset') || '0');
    
    const standupRows = await prisma.standup_reports.findMany({
      where: { workspace_id: workspaceId } as any,
      orderBy: { created_at: 'desc' },
      take: limit,
      skip: offset,
      select: { date: true, report: true, created_at: true },
    }) as Array<{ date: string; report: string; created_at: number }>;

    const standupHistory = standupRows.map((row, index) => {
      const report = row.report ? JSON.parse(row.report) : {};
      return {
        id: `${row.date}-${index}`,
        date: row.date || report.date || 'Unknown',
        generatedAt: report.generatedAt || new Date(row.created_at * 1000).toISOString(),
        summary: report.summary || {},
        agentCount: report.summary?.totalAgents || 0
      };
    });
    
    const total = await prisma.standup_reports.count({ where: { workspace_id: workspaceId } as any });

    return NextResponse.json({
      history: standupHistory,
      total,
      page: Math.floor(offset / limit) + 1,
      limit
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/standup/history error');
    return NextResponse.json({ error: 'Failed to fetch standup history' }, { status: 500 });
  }
}
