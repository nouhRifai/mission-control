/**
 * Background poller for GitHub ↔ MC task sync.
 * Lazy singleton — call startSyncPoller() to begin.
 */

import { logger } from '@/lib/logger'
import { pullFromGitHub } from '@/lib/github-sync-engine'
import { getPrismaClient } from '@/lib/prisma'

const INTERVAL_MS = parseInt(process.env.GITHUB_SYNC_INTERVAL_MS || '60000', 10)

let intervalHandle: ReturnType<typeof setInterval> | null = null
let lastRun: number | undefined

export function startSyncPoller(): void {
  if (intervalHandle) return

  logger.info({ intervalMs: INTERVAL_MS }, 'Starting GitHub sync poller')

  intervalHandle = setInterval(async () => {
    await runSyncTick()
  }, INTERVAL_MS)

  // Run immediately on start
  runSyncTick().catch(() => {})
}

export function stopSyncPoller(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
    logger.info('GitHub sync poller stopped')
  }
}

export function getSyncPollerStatus(): { running: boolean; interval: number; lastRun?: number } {
  return {
    running: intervalHandle !== null,
    interval: INTERVAL_MS,
    lastRun,
  }
}

async function runSyncTick(): Promise<void> {
  try {
    const prisma = getPrismaClient()

    const projects = await prisma.projects.findMany({
      where: {
        github_sync_enabled: 1,
        github_repo: { not: null },
        status: 'active',
      },
      select: {
        id: true,
        github_repo: true,
        github_sync_enabled: true,
        github_default_branch: true,
        workspace_id: true,
      },
    })

    for (const project of projects) {
      try {
        await pullFromGitHub(project, project.workspace_id)
      } catch (err) {
        logger.error({ err, projectId: project.id, repo: project.github_repo }, 'Sync poller: project sync failed')
      }
    }

    lastRun = Math.floor(Date.now() / 1000)
  } catch (err) {
    logger.error({ err }, 'Sync poller tick failed')
  }
}
