import { redirect } from "next/navigation"
import { newThreadId } from "@copilot/graph/thread-id"

export const dynamic = "force-dynamic"

/** `/` abre un hilo nuevo (R2). */
export default function Home() {
  redirect(`/threads/${newThreadId()}`)
}
