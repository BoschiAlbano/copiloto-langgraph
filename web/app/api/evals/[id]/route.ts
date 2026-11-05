import { getHandlers } from "@/lib/agent"

export const dynamic = "force-dynamic"

export async function GET(_request: Request, { params }: RouteContext<"/api/evals/[id]">) {
  return getHandlers().getEval((await params).id)
}
