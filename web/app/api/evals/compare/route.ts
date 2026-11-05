import { getHandlers } from "@/lib/agent"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  return getHandlers().compareEvals(new URL(request.url))
}
