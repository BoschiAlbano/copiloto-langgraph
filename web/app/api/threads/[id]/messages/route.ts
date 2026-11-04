import { getHandlers } from "@/lib/agent"

export const dynamic = "force-dynamic"

export async function POST(request: Request, { params }: RouteContext<"/api/threads/[id]/messages">) {
  return getHandlers().postMessage(request, (await params).id)
}
