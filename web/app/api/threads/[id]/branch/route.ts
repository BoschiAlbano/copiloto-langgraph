import { getHandlers } from "@/lib/agent"

export const dynamic = "force-dynamic"

export async function POST(request: Request, { params }: RouteContext<"/api/threads/[id]/branch">) {
  return getHandlers().postBranch(request, (await params).id)
}
