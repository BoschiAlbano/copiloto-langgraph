import { getHandlers } from "@/lib/agent"

export const dynamic = "force-dynamic"

export async function GET(_request: Request, { params }: RouteContext<"/api/threads/[id]/branches">) {
  return getHandlers().getBranches((await params).id)
}
