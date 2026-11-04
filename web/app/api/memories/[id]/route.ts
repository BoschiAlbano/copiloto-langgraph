import { getHandlers } from "@/lib/agent"

export const dynamic = "force-dynamic"

export async function DELETE(request: Request, { params }: RouteContext<"/api/memories/[id]">) {
  return getHandlers().deleteMemory(request, (await params).id)
}
