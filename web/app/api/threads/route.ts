import { listThreads } from "@copilot/graph/threads"
import { getAgent } from "@/lib/agent"

export const dynamic = "force-dynamic"

export async function GET() {
  const agent = getAgent()
  const threads = await listThreads({ pool: agent.pool, graph: agent.graph })
  return Response.json({ threads })
}
