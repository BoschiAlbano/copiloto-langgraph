import { getHandlers } from "@/lib/agent"

export const dynamic = "force-dynamic"

export async function POST(request: Request, { params }: RouteContext<"/api/threads/[id]/edit">) {
  return getHandlers().postEdit(request, (await params).id)
}
