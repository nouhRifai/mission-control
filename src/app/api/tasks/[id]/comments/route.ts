import { NextRequest, NextResponse } from 'next/server';
import { Comment, db_helpers } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { validateBody, createCommentSchema } from '@/lib/validation';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { resolveMentionRecipientsAsync } from '@/lib/mentions';
import { getPrismaClient } from '@/lib/prisma';

/**
 * GET /api/tasks/[id]/comments - Get all comments for a task
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
    const taskId = parseInt(resolvedParams.id);
    const workspaceId = auth.user.workspace_id ?? 1;

    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
    }
    
    // Verify task exists
    const task = await prisma.tasks.findFirst({
      where: { id: taskId, workspace_id: workspaceId },
      select: { id: true },
    })
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    
    // Get comments ordered by creation time
    const comments = await prisma.comments.findMany({
      where: { task_id: taskId, workspace_id: workspaceId },
      orderBy: { created_at: 'asc' },
    }) as unknown as Comment[];
    
    // Parse JSON fields and build thread structure
    const commentsWithParsedData = comments.map(comment => ({
      ...comment,
      mentions: comment.mentions ? JSON.parse(comment.mentions) : []
    }));
    
    // Organize into thread structure (parent comments with replies)
    const commentMap = new Map();
    const topLevelComments: any[] = [];
    
    // First pass: create all comment objects
    commentsWithParsedData.forEach(comment => {
      commentMap.set(comment.id, { ...comment, replies: [] });
    });
    
    // Second pass: organize into threads
    commentsWithParsedData.forEach(comment => {
      const commentWithReplies = commentMap.get(comment.id);
      
      if (comment.parent_id) {
        // This is a reply, add to parent's replies
        const parent = commentMap.get(comment.parent_id);
        if (parent) {
          parent.replies.push(commentWithReplies);
        }
      } else {
        // This is a top-level comment
        topLevelComments.push(commentWithReplies);
      }
    });
    
    return NextResponse.json({ 
      comments: topLevelComments,
      total: comments.length
    });
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/[id]/comments error');
    return NextResponse.json({ error: 'Failed to fetch comments' }, { status: 500 });
  }
}

/**
 * POST /api/tasks/[id]/comments - Add a new comment to a task
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(request, 'operator');
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const prisma = getPrismaClient();
    const resolvedParams = await params;
    const taskId = parseInt(resolvedParams.id);
    const workspaceId = auth.user.workspace_id ?? 1;

    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
    }

    const result = await validateBody(request, createCommentSchema);
    if ('error' in result) return result.error;
    const { content: rawContent, parent_id } = result.data;
    const author = auth.user.display_name || auth.user.username || 'system';

    // Normalize agent payload JSON — extract text from OpenClaw result format
    let content = rawContent;
    try {
      const stripped = rawContent.replace(/\x1b\[[0-9;]*m/g, '').replace(/\[3[0-9]m/g, '').replace(/\[39m/g, '');
      const parsed = JSON.parse(stripped);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.payloads)) {
        const text = parsed.payloads
          .map((p: any) => (typeof p === 'string' ? p : p?.text || '').trim())
          .filter(Boolean)
          .join('\n');
        if (text) {
          const meta = parsed.meta?.agentMeta;
          const metaLine = meta
            ? `\n\n_${[meta.model, meta.usage?.total ? `${meta.usage.total} tokens` : '', parsed.meta?.durationMs ? `${(parsed.meta.durationMs / 1000).toFixed(1)}s` : ''].filter(Boolean).join(' · ')}_`
            : '';
          content = text + metaLine;
        }
      }
    } catch {
      // Not JSON — keep original content
    }

    // Verify task exists
    const task = await prisma.tasks.findFirst({
      where: { id: taskId, workspace_id: workspaceId },
    }) as any;
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    
    // Verify parent comment exists if specified
    if (parent_id) {
      const parentComment = await prisma.comments.findFirst({
        where: { id: parent_id, task_id: taskId, workspace_id: workspaceId },
        select: { id: true },
      })
      if (!parentComment) {
        return NextResponse.json({ error: 'Parent comment not found' }, { status: 404 });
      }
    }
    
    const mentionResolution = await resolveMentionRecipientsAsync(content, workspaceId);
    if (mentionResolution.unresolved.length > 0) {
      return NextResponse.json({
        error: `Unknown mentions: ${mentionResolution.unresolved.map((m) => `@${m}`).join(', ')}`,
        missing_mentions: mentionResolution.unresolved
      }, { status: 400 });
    }
    
    const now = Math.floor(Date.now() / 1000);
    
    // Insert comment
    const created = await prisma.comments.create({
      data: {
        task_id: taskId,
        author,
        content,
        created_at: now,
        parent_id: parent_id || null,
        mentions: mentionResolution.tokens.length > 0 ? JSON.stringify(mentionResolution.tokens) : null,
        workspace_id: workspaceId,
      } as any,
      select: { id: true },
    })
    const commentId = created.id
    
    // Log activity
    const activityDescription = parent_id 
      ? `Replied to comment on task: ${task.title}`
      : `Added comment to task: ${task.title}`;
    
    db_helpers.logActivity(
      'comment_added',
      'comment',
      commentId,
      author,
      activityDescription,
      {
        task_id: taskId,
        task_title: task.title,
        parent_id,
        mentions: mentionResolution.tokens,
        content_preview: content.substring(0, 100)
      },
      workspaceId
    );
    
    // Ensure subscriptions for author, mentions, and assignee
    db_helpers.ensureTaskSubscription(taskId, author, workspaceId);
    const mentionRecipients = mentionResolution.recipients;
    mentionRecipients.forEach((mentionedRecipient) => {
      db_helpers.ensureTaskSubscription(taskId, mentionedRecipient, workspaceId);
    });
    if (task.assigned_to) {
      db_helpers.ensureTaskSubscription(taskId, task.assigned_to, workspaceId);
    }

    // Notify subscribers
    const subscribers = new Set(await db_helpers.getTaskSubscribers(taskId, workspaceId));
    subscribers.delete(author);
    const mentionSet = new Set(mentionRecipients);

    for (const subscriber of subscribers) {
      const isMention = mentionSet.has(subscriber);
      db_helpers.createNotification(
        subscriber,
        isMention ? 'mention' : 'comment',
        isMention ? 'You were mentioned' : 'New comment on a subscribed task',
        isMention
          ? `${author} mentioned you in a comment on "${task.title}": ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`
          : `${author} commented on "${task.title}": ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`,
        'comment',
        commentId,
        workspaceId
      );
    }
    
    // Fetch the created comment
    const createdComment = await prisma.comments.findFirst({
      where: { id: commentId, workspace_id: workspaceId },
    }) as unknown as Comment | null;
    if (!createdComment) throw new Error('Comment not found after create')
    
    return NextResponse.json({ 
      comment: {
        ...createdComment,
        mentions: createdComment.mentions ? JSON.parse(createdComment.mentions) : [],
        replies: [] // New comments have no replies initially
      }
    }, { status: 201 });
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/[id]/comments error');
    return NextResponse.json({ error: 'Failed to add comment' }, { status: 500 });
  }
}
