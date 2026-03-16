import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { runOpenClaw } from '@/lib/command'
import { logAuditEvent } from '@/lib/db'
import { logger } from '@/lib/logger'

export async function POST(request: Request) {
  const auth = await requireRole(request, 'admin')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  let installedBefore: string | null = null

  try {
    const vResult = await runOpenClaw(['--version'], { timeoutMs: 3000 })
    const match = vResult.stdout.match(/(\d+\.\d+\.\d+)/)
    if (match) installedBefore = match[1]
  } catch {
    return NextResponse.json(
      { error: 'OpenClaw is not installed or not reachable' },
      { status: 400 }
    )
  }

  try {
    const result = await runOpenClaw(['update', '--channel', 'stable'], {
      timeoutMs: 5 * 60 * 1000,
    })

    // Read new version after update
    let installedAfter: string | null = null
    try {
      const vResult = await runOpenClaw(['--version'], { timeoutMs: 3000 })
      const match = vResult.stdout.match(/(\d+\.\d+\.\d+)/)
      if (match) installedAfter = match[1]
    } catch { /* keep null */ }

    // Audit log
    logAuditEvent({
      action: 'openclaw.update',
      actor: auth.user.username,
      actor_id: auth.user.id,
      detail: { previousVersion: installedBefore, newVersion: installedAfter },
    })

    return NextResponse.json({
      success: true,
      previousVersion: installedBefore,
      newVersion: installedAfter,
      output: result.stdout,
    })
  } catch (err: any) {
    const detail =
      err?.stderr?.toString?.()?.trim() ||
      err?.stdout?.toString?.()?.trim() ||
      err?.message ||
      'Unknown error during OpenClaw update'

    logger.error({ err }, 'OpenClaw update failed')

    return NextResponse.json(
      { error: 'OpenClaw update failed', detail },
      { status: 500 }
    )
  }
}
