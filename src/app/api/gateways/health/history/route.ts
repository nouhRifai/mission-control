import { NextRequest, NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getPrismaClient } from "@/lib/prisma"

interface GatewayHealthLogRow {
  gateway_id: number
  gateway_name: string | null
  status: string
  latency: number | null
  probed_at: number
  error: string | null
}

interface GatewayHistoryEntry {
  status: string
  latency: number | null
  probed_at: number
  error: string | null
}

interface GatewayHistory {
  gatewayId: number
  name: string | null
  entries: GatewayHistoryEntry[]
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, "viewer")
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const prisma = getPrismaClient()
  const rows = await prisma.$queryRaw<GatewayHealthLogRow[]>`
    SELECT l.gateway_id, g.name AS gateway_name, l.status, l.latency, l.probed_at, l.error
    FROM gateway_health_logs l
    LEFT JOIN gateways g ON g.id = l.gateway_id
    ORDER BY l.probed_at DESC
    LIMIT 100
  `

  const historyMap: Record<number, GatewayHistory> = {}

  for (const row of rows) {
    const entry: GatewayHistoryEntry = {
      status: row.status,
      latency: row.latency,
      probed_at: row.probed_at,
      error: row.error,
    }

    if (!historyMap[row.gateway_id]) {
      historyMap[row.gateway_id] = {
        gatewayId: row.gateway_id,
        name: row.gateway_name,
        entries: [],
      }
    }

    historyMap[row.gateway_id].entries.push(entry)
  }

  const history = Object.values(historyMap)
  return NextResponse.json({ history })
}
