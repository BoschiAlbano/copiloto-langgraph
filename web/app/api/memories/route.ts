import { getHandlers } from "@/lib/agent"

export const dynamic = "force-dynamic"

export function GET() {
  return getHandlers().listMemories()
}
