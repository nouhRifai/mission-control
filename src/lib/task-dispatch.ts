import { db_helpers } from './db'
import { runOpenClaw } from './command'
import { eventBus } from './event-bus'
import { logger } from './logger'
import { getPrismaClient } from './prisma'

interface DispatchableTask {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  assigned_to: string
  workspace_id: number
  agent_name: string
  agent_id: number
  agent_config: string | null
  ticket_prefix: string | null
  project_ticket_no: number | null
  project_id: number | null
  tags?: string[]
}

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------

/**
 * Classify a task's complexity and return the appropriate model ID to pass
 * to the OpenClaw gateway. Uses keyword signals on title + description.
 *
 * Tiers:
 *   ROUTINE  → cheap model (Haiku)   — file ops, status checks, formatting
 *   MODERATE → mid model  (Sonnet)   — code gen, summaries, analysis, drafts
 *   COMPLEX  → premium model (Opus)  — debugging, architecture, novel problems
 *
 * The caller may override this by setting agent.config.dispatchModel.
 */
function classifyTaskModel(task: DispatchableTask): string | null {
  // Allow per-agent config override
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.dispatchModel === 'string' && cfg.dispatchModel) return cfg.dispatchModel
    } catch { /* ignore */ }
  }

  const text = `${task.title} ${task.description ?? ''}`.toLowerCase()
  const priority = task.priority?.toLowerCase() ?? ''

  // Complex signals → Opus
  const complexSignals = [
    'debug', 'diagnos', 'architect', 'design system', 'security audit',
    'root cause', 'investigate', 'incident', 'failure', 'broken', 'not working',
    'refactor', 'migration', 'performance optim', 'why is',
  ]
  if (priority === 'critical' || complexSignals.some(s => text.includes(s))) {
    return '9router/cc/claude-opus-4-6'
  }

  // Routine signals → Haiku
  const routineSignals = [
    'status check', 'health check', 'ping', 'list ', 'fetch ', 'format',
    'rename', 'move file', 'read file', 'update readme', 'bump version',
    'send message', 'post to', 'notify', 'summarize', 'translate',
    'quick ', 'simple ', 'routine ', 'minor ',
  ]
  if (priority === 'low' && routineSignals.some(s => text.includes(s))) {
    return '9router/cc/claude-haiku-4-5-20251001'
  }
  if (routineSignals.some(s => text.includes(s)) && priority !== 'high' && priority !== 'critical') {
    return '9router/cc/claude-haiku-4-5-20251001'
  }

  // Default: let the agent's own configured model handle it (no override)
  return null
}

/** Extract the gateway agent identifier from the agent's config JSON.
 *  Falls back to agent_name (display name) if openclawId is not set. */
function resolveGatewayAgentId(task: DispatchableTask): string {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.openclawId === 'string' && cfg.openclawId) return cfg.openclawId
    } catch { /* ignore */ }
  }
  return task.agent_name
}

function buildTaskPrompt(task: DispatchableTask, rejectionFeedback?: string | null): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
    : `TASK-${task.id}`

  const lines = [
    'You have been assigned a task in Mission Control.',
    '',
    `**[${ticket}] ${task.title}**`,
    `Priority: ${task.priority}`,
  ]

  if (task.tags && task.tags.length > 0) {
    lines.push(`Tags: ${task.tags.join(', ')}`)
  }

  if (task.description) {
    lines.push('', task.description)
  }

  if (rejectionFeedback) {
    lines.push('', '## Previous Review Feedback', rejectionFeedback, '', 'Please address this feedback in your response.')
  }

  lines.push('', 'Complete this task and provide your response. Be concise and actionable.')
  return lines.join('\n')
}

/** Extract first valid JSON object from raw stdout (handles surrounding text/warnings). */
function parseGatewayJson(raw: string): any | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

interface AgentResponseParsed {
  text: string | null
  sessionId: string | null
}

function parseAgentResponse(stdout: string): AgentResponseParsed {
  try {
    const parsed = JSON.parse(stdout)
    const sessionId: string | null = typeof parsed?.sessionId === 'string' ? parsed.sessionId
      : typeof parsed?.session_id === 'string' ? parsed.session_id
      : null

    // OpenClaw agent --json returns { payloads: [{ text: "..." }] }
    if (parsed?.payloads?.[0]?.text) {
      return { text: parsed.payloads[0].text, sessionId }
    }
    // Fallback: if there's a result or output field
    if (parsed?.result) return { text: String(parsed.result), sessionId }
    if (parsed?.output) return { text: String(parsed.output), sessionId }
    // Last resort: stringify the whole response
    return { text: JSON.stringify(parsed, null, 2), sessionId }
  } catch {
    // Not valid JSON — return raw stdout if non-empty
    return { text: stdout.trim() || null, sessionId: null }
  }
}

interface ReviewableTask {
  id: number
  title: string
  description: string | null
  resolution: string | null
  assigned_to: string | null
  agent_config: string | null
  workspace_id: number
  ticket_prefix: string | null
  project_ticket_no: number | null
}

function resolveGatewayAgentIdForReview(task: ReviewableTask): string {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.openclawId === 'string' && cfg.openclawId) return cfg.openclawId
    } catch { /* ignore */ }
  }
  return task.assigned_to || 'jarv'
}

function buildReviewPrompt(task: ReviewableTask): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
    : `TASK-${task.id}`

  const lines = [
    'You are Aegis, the quality reviewer for Mission Control.',
    'Review the following completed task and its resolution.',
    '',
    `**[${ticket}] ${task.title}**`,
  ]

  if (task.description) {
    lines.push('', '## Task Description', task.description)
  }

  if (task.resolution) {
    lines.push('', '## Agent Resolution', task.resolution.substring(0, 6000))
  }

  lines.push(
    '',
    '## Instructions',
    'Evaluate whether the agent\'s response adequately addresses the task.',
    'Respond with EXACTLY one of these two formats:',
    '',
    'If the work is acceptable:',
    'VERDICT: APPROVED',
    'NOTES: <brief summary of why it passes>',
    '',
    'If the work needs improvement:',
    'VERDICT: REJECTED',
    'NOTES: <specific issues that need to be fixed>',
  )

  return lines.join('\n')
}

function parseReviewVerdict(text: string): { status: 'approved' | 'rejected'; notes: string } {
  const upper = text.toUpperCase()
  const status = upper.includes('VERDICT: APPROVED') ? 'approved' as const : 'rejected' as const
  const notesMatch = text.match(/NOTES:\s*(.+)/i)
  const notes = notesMatch?.[1]?.trim().substring(0, 2000) || (status === 'approved' ? 'Quality check passed' : 'Quality check failed')
  return { status, notes }
}

/**
 * Run Aegis quality reviews on tasks in 'review' status.
 * Uses an agent to evaluate the task resolution, then approves or rejects.
 */
export async function runAegisReviews(): Promise<{ ok: boolean; message: string }> {
  const prisma = getPrismaClient()

  const tasks = await prisma.$queryRaw<ReviewableTask[]>`
    SELECT t.id, t.title, t.description, t.resolution, t.assigned_to, t.workspace_id,
           p.ticket_prefix, t.project_ticket_no, a.config as agent_config
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    LEFT JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    WHERE t.status = 'review'
    ORDER BY t.updated_at ASC
    LIMIT 3
  `

  if (tasks.length === 0) {
    return { ok: true, message: 'No tasks awaiting review' }
  }

  const results: Array<{ id: number; verdict: string; error?: string }> = []

  for (const task of tasks) {
    const now = Math.floor(Date.now() / 1000)
    // Move to quality_review to prevent re-processing
    await prisma.tasks.update({
      where: { id: task.id },
      data: { status: 'quality_review', updated_at: now },
      select: { id: true },
    })

    eventBus.broadcast('task.status_changed', {
      id: task.id,
      status: 'quality_review',
      previous_status: 'review',
    })

    try {
      const prompt = buildReviewPrompt(task)
      // Resolve the gateway agent ID from config, falling back to assigned_to or default
      const reviewAgent = resolveGatewayAgentIdForReview(task)

      const invokeParams = {
        message: prompt,
        agentId: reviewAgent,
        idempotencyKey: `aegis-review-${task.id}-${Date.now()}`,
        deliver: false,
      }
      // Use --expect-final to block until the agent completes and returns the full
      // response payload (payloads[0].text). The two-step agent → agent.wait pattern
      // only returns lifecycle metadata (runId/status/timestamps) and never includes
      // the agent's actual text, so Aegis could never parse a verdict.
      const finalResult = await runOpenClaw(
        ['gateway', 'call', 'agent', '--expect-final', '--timeout', '120000', '--params', JSON.stringify(invokeParams), '--json'],
        { timeoutMs: 125_000 }
      )
      const finalPayload = parseGatewayJson(finalResult.stdout)
        ?? parseGatewayJson(String((finalResult as any)?.stderr || ''))
      const agentResponse = parseAgentResponse(
        finalPayload?.result ? JSON.stringify(finalPayload.result) : finalResult.stdout
      )
      if (!agentResponse.text) {
        throw new Error('Aegis review returned empty response')
      }

      const verdict = parseReviewVerdict(agentResponse.text)

      // Insert quality review record
      await prisma.quality_reviews.create({
        data: {
          task_id: task.id,
          reviewer: 'aegis',
          status: verdict.status,
          notes: verdict.notes,
          workspace_id: task.workspace_id,
          created_at: now,
        },
        select: { id: true },
      })

      if (verdict.status === 'approved') {
        await prisma.tasks.update({
          where: { id: task.id },
          data: { status: 'done', updated_at: now },
          select: { id: true },
        })

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'done',
          previous_status: 'quality_review',
        })
      } else {
        // Rejected: push back to in_progress with feedback
        await prisma.tasks.update({
          where: { id: task.id },
          data: {
            status: 'in_progress',
            error_message: `Aegis rejected: ${verdict.notes}`,
            updated_at: now,
          },
          select: { id: true },
        })

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'in_progress',
          previous_status: 'quality_review',
        })

        // Add rejection as a comment so the agent sees it on next dispatch
        await prisma.comments.create({
          data: {
            task_id: task.id,
            author: 'aegis',
            content: `Quality Review Rejected:\n${verdict.notes}`,
            created_at: now,
            workspace_id: task.workspace_id,
          },
          select: { id: true },
        })
      }

      db_helpers.logActivity(
        'aegis_review',
        'task',
        task.id,
        'aegis',
        `Aegis ${verdict.status} task "${task.title}": ${verdict.notes.substring(0, 200)}`,
        { verdict: verdict.status, notes: verdict.notes },
        task.workspace_id
      )

      results.push({ id: task.id, verdict: verdict.status })
      logger.info({ taskId: task.id, verdict: verdict.status }, 'Aegis review completed')
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error'
      logger.error({ taskId: task.id, err }, 'Aegis review failed')

      // Revert to review so it can be retried
      await prisma.tasks.update({
        where: { id: task.id },
        data: { status: 'review', updated_at: now },
        select: { id: true },
      })

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'review',
        previous_status: 'quality_review',
      })

      results.push({ id: task.id, verdict: 'error', error: errorMsg.substring(0, 100) })
    }
  }

  const approved = results.filter(r => r.verdict === 'approved').length
  const rejected = results.filter(r => r.verdict === 'rejected').length
  const errors = results.filter(r => r.verdict === 'error').length

  return {
    ok: errors === 0,
    message: `Reviewed ${tasks.length}: ${approved} approved, ${rejected} rejected${errors ? `, ${errors} error(s)` : ''}`,
  }
}

export async function dispatchAssignedTasks(): Promise<{ ok: boolean; message: string }> {
  const prisma = getPrismaClient()

  const tasks = await prisma.$queryRaw<(DispatchableTask & { tags?: string; metadata?: string | null })[]>`
    SELECT t.*, a.name as agent_name, a.id as agent_id, a.config as agent_config,
           p.ticket_prefix, t.project_ticket_no
    FROM tasks t
    JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.status = 'assigned'
      AND t.assigned_to IS NOT NULL
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
      t.created_at ASC
    LIMIT 3
  `

  if (tasks.length === 0) {
    return { ok: true, message: 'No assigned tasks to dispatch' }
  }

  // Parse JSON tags column
  for (const task of tasks) {
    if (typeof task.tags === 'string') {
      try { task.tags = JSON.parse(task.tags as string) } catch { task.tags = undefined }
    }
  }

  const results: Array<{ id: number; success: boolean; error?: string }> = []
  const now = Math.floor(Date.now() / 1000)

  for (const task of tasks) {
    // Mark as in_progress immediately to prevent re-dispatch
    await prisma.tasks.update({
      where: { id: task.id },
      data: { status: 'in_progress', updated_at: now },
      select: { id: true },
    })

    eventBus.broadcast('task.status_changed', {
      id: task.id,
      status: 'in_progress',
      previous_status: 'assigned',
    })

    db_helpers.logActivity(
      'task_dispatched',
      'task',
      task.id,
      'scheduler',
      `Dispatching task "${task.title}" to agent ${task.agent_name}`,
      { agent: task.agent_name, priority: task.priority },
      task.workspace_id
    )

    try {
      // Check for previous Aegis rejection feedback
      const rejectionRow = await prisma.comments.findFirst({
        where: {
          task_id: task.id,
          author: 'aegis',
          content: { startsWith: 'Quality Review Rejected:' },
        },
        orderBy: { created_at: 'desc' },
        select: { content: true },
      })
      const rejectionFeedback = rejectionRow?.content?.replace(/^Quality Review Rejected:\n?/, '') || null

      const prompt = buildTaskPrompt(task, rejectionFeedback)

      // Step 1: Invoke via gateway
      const gatewayAgentId = resolveGatewayAgentId(task)
      const dispatchModel = classifyTaskModel(task)
      const invokeParams: Record<string, unknown> = {
        message: prompt,
        agentId: gatewayAgentId,
        idempotencyKey: `task-dispatch-${task.id}-${Date.now()}`,
        deliver: false,
      }
      // Route to appropriate model tier based on task complexity.
      // null = no override, agent uses its own configured default model.
      if (dispatchModel) invokeParams.model = dispatchModel

      // Use --expect-final to block until the agent completes and returns the full
      // response payload (result.payloads[0].text). The two-step agent → agent.wait
      // pattern only returns lifecycle metadata and never includes the agent's text.
      const finalResult = await runOpenClaw(
        ['gateway', 'call', 'agent', '--expect-final', '--timeout', '120000', '--params', JSON.stringify(invokeParams), '--json'],
        { timeoutMs: 125_000 }
      )
      const finalPayload = parseGatewayJson(finalResult.stdout)
        ?? parseGatewayJson(String((finalResult as any)?.stderr || ''))

      const agentResponse = parseAgentResponse(
        finalPayload?.result ? JSON.stringify(finalPayload.result) : finalResult.stdout
      )
      if (!agentResponse.sessionId && finalPayload?.result?.meta?.agentMeta?.sessionId) {
        agentResponse.sessionId = finalPayload.result.meta.agentMeta.sessionId
      }

      if (!agentResponse.text) {
        throw new Error('Agent returned empty response')
      }

      const truncated = agentResponse.text.length > 10_000
        ? agentResponse.text.substring(0, 10_000) + '\n\n[Response truncated at 10,000 characters]'
        : agentResponse.text

      // Merge dispatch_session_id into existing metadata
      const existingMeta = (() => {
        try {
          const raw = (task as any)?.metadata
          return raw ? JSON.parse(raw) : {}
        } catch { return {} }
      })()
      if (agentResponse.sessionId) {
        existingMeta.dispatch_session_id = agentResponse.sessionId
      }

      // Update task: status → review, set outcome
      await prisma.tasks.update({
        where: { id: task.id },
        data: {
          status: 'review',
          outcome: 'success',
          resolution: truncated,
          metadata: JSON.stringify(existingMeta),
          updated_at: Math.floor(Date.now() / 1000),
        },
        select: { id: true },
      })

      // Add a comment from the agent with the full response
      await prisma.comments.create({
        data: {
          task_id: task.id,
          author: task.agent_name,
          content: truncated,
          created_at: Math.floor(Date.now() / 1000),
          workspace_id: task.workspace_id,
        },
        select: { id: true },
      })

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'review',
        previous_status: 'in_progress',
      })

      eventBus.broadcast('task.updated', {
        id: task.id,
        status: 'review',
        outcome: 'success',
        assigned_to: task.assigned_to,
        dispatch_session_id: agentResponse.sessionId,
      })

      db_helpers.logActivity(
        'task_agent_completed',
        'task',
        task.id,
        task.agent_name,
        `Agent completed task "${task.title}" — awaiting review`,
        { response_length: agentResponse.text.length, dispatch_session_id: agentResponse.sessionId },
        task.workspace_id
      )

      results.push({ id: task.id, success: true })
      logger.info({ taskId: task.id, agent: task.agent_name }, 'Task dispatched and completed')
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error'
      logger.error({ taskId: task.id, agent: task.agent_name, err }, 'Task dispatch failed')

      // Revert to assigned so it can be retried on the next tick
      await prisma.tasks.update({
        where: { id: task.id },
        data: {
          status: 'assigned',
          error_message: errorMsg.substring(0, 5000),
          updated_at: Math.floor(Date.now() / 1000),
        },
        select: { id: true },
      })

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'assigned',
        previous_status: 'in_progress',
      })

      db_helpers.logActivity(
        'task_dispatch_failed',
        'task',
        task.id,
        'scheduler',
        `Task dispatch failed for "${task.title}": ${errorMsg.substring(0, 200)}`,
        { error: errorMsg.substring(0, 1000) },
        task.workspace_id
      )

      results.push({ id: task.id, success: false, error: errorMsg.substring(0, 100) })
    }
  }

  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success)
  const failSummary = failed.length > 0
    ? ` (${failed.length} failed: ${failed.map(f => f.error).join('; ')})`
    : ''

  return {
    ok: failed.length === 0,
    message: `Dispatched ${succeeded}/${tasks.length} tasks${failSummary}`,
  }
}
