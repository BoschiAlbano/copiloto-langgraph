import { getHandlers } from "@/lib/agent"

export const dynamic = "force-dynamic"

export async function GET() {
  return getHandlers().listEvals()
}
