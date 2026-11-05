import { getHandlers } from "@/lib/agent"

export const dynamic = "force-dynamic"

export async function POST(request: Request, { params }: RouteContext<"/api/threads/[id]/retry">) {
  return getHandlers().postRetry(request, (await params).id)
}
