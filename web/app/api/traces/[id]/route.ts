import { getHandlers } from "@/lib/agent"

export const dynamic = "force-dynamic"

export async function GET(_request: Request, { params }: RouteContext<"/api/traces/[id]">) {
  return getHandlers().getTrace((await params).id)
}
