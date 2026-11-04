import { notFound } from "next/navigation"
import type { ThreadSummary } from "@copilot/graph/threads"
import type { ThreadView } from "@copilot/web/handlers"
import { ChatApp } from "@/components/chat/chat-app"
import { getHandlers } from "@/lib/agent"

export const dynamic = "force-dynamic"

// La página de un hilo (R2, R3): se arma en el servidor con lo guardado, así recargar muestra la conversación, la
// tarjeta o el «Continuar» sin parpadeos.
export default async function ThreadPage({ params }: PageProps<"/threads/[id]">) {
  const { id } = await params
  const handlers = getHandlers()
  const response = await handlers.getThread(id)
  if (response.status === 400) notFound()
  if (!response.ok) throw new Error("No se pudo leer el hilo.")
  const view = (await response.json()) as ThreadView
  const threads = await handlers
    .listThreads()
    .then((r) => (r.ok ? (r.json() as Promise<{ threads: ThreadSummary[] }>) : { threads: [] }))
    .then((r) => r.threads)
  return <ChatApp key={id} initial={view} initialThreads={threads} />
}
