import { NextRequest, NextResponse } from 'next/server';
import { Notification, db_helpers } from '@/lib/db';
import { runOpenClaw } from '@/lib/command';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { getPrismaClient } from '@/lib/prisma';

/**
 * POST /api/notifications/deliver - Notification delivery daemon endpoint
 * 
 * Polls undelivered notifications and sends them to agents
 * via OpenClaw gateway call agent command
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const prisma = getPrismaClient();
    const body = await request.json();
    const workspaceId = auth.user.workspace_id ?? 1;
    const {
      agent_filter, // Optional: only deliver to specific agent
      limit = 50,   // Max notifications to process per call
      dry_run = false // Test mode - don't actually deliver
    } = body;
    
    // Get undelivered notifications
    const undeliveredNotifications = await prisma.notifications.findMany({
      where: {
        delivered_at: null,
        workspace_id: workspaceId,
        ...(agent_filter ? { recipient: agent_filter } : {}),
      },
      orderBy: { created_at: 'asc' },
      take: Math.min(Number(limit) || 50, 500),
    }) as unknown as (Notification & { session_key?: string })[]

    const recipients = Array.from(
      new Set(undeliveredNotifications.map((n) => n.recipient).filter(Boolean))
    ) as string[]
    const agents = recipients.length
      ? await prisma.agents.findMany({
          where: { workspace_id: workspaceId, name: { in: recipients } },
          select: { name: true, session_key: true },
        })
      : []
    const sessionKeyByAgent = new Map(agents.map((a) => [a.name, a.session_key]))
    for (const n of undeliveredNotifications) {
      ;(n as any).session_key = sessionKeyByAgent.get(n.recipient) || null
    }
    
    if (undeliveredNotifications.length === 0) {
      return NextResponse.json({
        status: 'success',
        message: 'No undelivered notifications found',
        processed: 0,
        delivered: 0,
        errors: []
      });
    }
    
    let deliveredCount = 0;
    let errorCount = 0;
    const errors: any[] = [];
    const deliveryResults: any[] = [];

    for (const notification of undeliveredNotifications) {
      try {
        // Skip if agent is not registered in the agents table
        if (!notification.recipient) {
          errors.push({
            notification_id: notification.id,
            recipient: notification.recipient,
            error: 'Notification has no recipient'
          });
          errorCount++;
          continue;
        }
        
        // Format message for delivery
        const message = formatNotificationMessage(notification);
        
        if (!dry_run) {
          // Send notification via OpenClaw gateway call agent
          try {
            const invokeParams = {
              message,
              agentId: notification.recipient,
              idempotencyKey: `notification-${notification.id}-${Date.now()}`,
              deliver: false,
            };
            const { stdout, stderr } = await runOpenClaw(
              [
                'gateway',
                'call',
                'agent',
                '--params',
                JSON.stringify(invokeParams),
                '--json'
              ],
              { timeoutMs: 30000 }
            );

            if (stderr && stderr.includes('error')) {
              throw new Error(`OpenClaw error: ${stderr}`);
            }
            
            // Mark as delivered
            const now = Math.floor(Date.now() / 1000);
            await prisma.notifications.updateMany({
              where: { id: (notification as any).id, workspace_id: workspaceId },
              data: { delivered_at: now },
            })
            
            deliveredCount++;
            deliveryResults.push({
              notification_id: notification.id,
              recipient: notification.recipient,
              session_key: notification.session_key,
              delivered_at: now,
              status: 'delivered',
              stdout: stdout.substring(0, 200) // Truncate for storage
            });
            
            // Log successful delivery
            db_helpers.logActivity(
              'notification_delivered',
              'notification',
              notification.id,
              'system',
              `Notification delivered to ${notification.recipient}`,
              {
                notification_type: notification.type,
                session_key: notification.session_key,
                title: notification.title
              },
              workspaceId
            );
          } catch (cmdError: any) {
            throw new Error(`Command failed: ${cmdError.message}`);
          }
        } else {
          // Dry run - just log what would be sent
          deliveryResults.push({
            notification_id: notification.id,
            recipient: notification.recipient,
            session_key: notification.session_key,
            status: 'dry_run',
            message: message
          });
          deliveredCount++;
        }
      } catch (error: any) {
        errorCount++;
        errors.push({
          notification_id: notification.id,
          recipient: notification.recipient,
          error: error.message
        });
        
        logger.error({ err: error, notificationId: notification.id, recipient: notification.recipient }, 'Failed to deliver notification');
      }
    }
    
    // Log delivery batch summary
    db_helpers.logActivity(
      'notification_delivery_batch',
      'system',
      0,
      'notification_daemon',
      `Processed ${undeliveredNotifications.length} notifications: ${deliveredCount} delivered, ${errorCount} failed`,
      {
        total_processed: undeliveredNotifications.length,
        delivered: deliveredCount,
        errors: errorCount,
        dry_run,
        agent_filter: agent_filter || null
      },
      workspaceId
    );
    
    return NextResponse.json({
      status: 'success',
      message: `Processed ${undeliveredNotifications.length} notifications`,
      total_processed: undeliveredNotifications.length,
      delivered: deliveredCount,
      errors: errorCount,
      dry_run,
      delivery_results: deliveryResults,
      error_details: errors
    });
  } catch (error) {
    logger.error({ err: error }, 'POST /api/notifications/deliver error');
    return NextResponse.json({ error: 'Failed to deliver notifications' }, { status: 500 });
  }
}

/**
 * GET /api/notifications/deliver - Get delivery status and statistics
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const prisma = getPrismaClient();
    const { searchParams } = new URL(request.url);
    const workspaceId = auth.user.workspace_id ?? 1;
    const agent = searchParams.get('agent');
    
    // Get delivery statistics
    const baseWhere: any = { workspace_id: workspaceId }
    if (agent) baseWhere.recipient = agent

    const [totalCount, undeliveredCount, deliveredCount] = await Promise.all([
      prisma.notifications.count({ where: baseWhere }),
      prisma.notifications.count({ where: { ...baseWhere, delivered_at: null } }),
      prisma.notifications.count({ where: { ...baseWhere, delivered_at: { not: null } } }),
    ])
    
    // Get recent delivery activity
    const recentDeliveries = await prisma.notifications.findMany({
      where: { ...baseWhere, delivered_at: { not: null } },
      select: { recipient: true, type: true, title: true, delivered_at: true, created_at: true },
      orderBy: { delivered_at: 'desc' },
      take: 10,
    })
    
    // Get agents with pending notifications
    // Prisma `groupBy` typings can be fragile when the client is generated in dual-provider mode,
    // so we count recipients in-memory. This endpoint is diagnostics-style and bounded by workspace.
    const pendingRows = await prisma.notifications.findMany({
      where: { ...baseWhere, delivered_at: null },
      select: { recipient: true },
    })
    const pendingByRecipient = new Map<string, number>()
    for (const row of pendingRows) {
      if (!row.recipient) continue
      pendingByRecipient.set(row.recipient, (pendingByRecipient.get(row.recipient) ?? 0) + 1)
    }
    const pendingGroups = Array.from(pendingByRecipient.entries())
      .map(([recipient, pending_count]) => ({ recipient, pending_count }))
      .sort((a, b) => b.pending_count - a.pending_count)
    const pendingRecipients = pendingGroups.map((g) => g.recipient)
    const pendingAgents = pendingRecipients.length
      ? await prisma.agents.findMany({
          where: { workspace_id: workspaceId, name: { in: pendingRecipients } },
          select: { name: true, session_key: true },
        })
      : []
    const pendingSessionKey = new Map(pendingAgents.map((a) => [a.name, a.session_key]))
    const agentsPending = pendingGroups.map((g) => ({
      recipient: g.recipient,
      session_key: pendingSessionKey.get(g.recipient) ?? null,
      pending_count: g.pending_count,
    }))
    
    return NextResponse.json({
      statistics: {
        total: totalCount,
        delivered: deliveredCount,
        undelivered: undeliveredCount,
        delivery_rate: totalCount > 0 ? 
          Math.round((deliveredCount / totalCount) * 100) : 0
      },
      agents_with_pending: agentsPending,
      recent_deliveries: recentDeliveries,
      agent_filter: agent
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/notifications/deliver error');
    return NextResponse.json({ error: 'Failed to get delivery status' }, { status: 500 });
  }
}

/**
 * Format notification for delivery to agent session
 */
function formatNotificationMessage(notification: Notification): string {
  const timestamp = new Date(notification.created_at * 1000).toLocaleString();
  
  let message = `🔔 **${notification.title}**\n\n`;
  message += `${notification.message}\n\n`;
  
  if (notification.type === 'mention') {
    message += `📝 You were mentioned in a comment\n`;
  } else if (notification.type === 'assignment') {
    message += `📋 You have been assigned a new task\n`;
  } else if (notification.type === 'due_date') {
    message += `⏰ Task deadline approaching\n`;
  }
  
  if (notification.source_type && notification.source_id) {
    message += `🔗 Related ${notification.source_type} ID: ${notification.source_id}\n`;
  }
  
  message += `⏰ ${timestamp}`;
  
  return message;
}
