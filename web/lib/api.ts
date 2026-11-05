import type { UiEvent } from "@copilot/web/events"
import type { BranchSwitchView, BranchTree, ThreadView } from "@copilot/web/handlers"
import { readSse } from "@copilot/web/sse"
import type { ThreadSummary } from "@copilot/graph/threads"
import type { Memory } from "@copilot/memory/store"

// Lo que el navegador le pide al servidor. Las rutas que cambian algo mandan JSON (el servidor lo exige, R13); el
// navegador pone el Origin solo.

const JSON_HEADERS = { "Content-Type": "application/json" }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

async function errorOf(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
  return new ApiError(response.status, body?.error ?? `El servidor respondió ${response.status}.`)
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" })
  if (!response.ok) throw await errorOf(response)
  return (await response.json()) as T
}

export const fetchThread = (threadId: string) => getJson<ThreadView>(`/api/threads/${threadId}`)
export const fetchThreads = () => getJson<{ threads: ThreadSummary[] }>("/api/threads").then((r) => r.threads)
export const fetchBranches = (threadId: string) => getJson<BranchTree>(`/api/threads/${threadId}/branches`)
export const fetchMemories = () => getJson<{ memories: Memory[] }>("/api/memories").then((r) => r.memories)

/** Abre una versión de la conversación (specs/ramas-del-hilo.md): no corre ningún turno, responde con el hilo. */
export async function openBranch(threadId: string, checkpointId: string): Promise<BranchSwitchView> {
  const response = await fetch(`/api/threads/${threadId}/branch`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ checkpointId }) })
  if (!response.ok) throw await errorOf(response)
  return (await response.json()) as BranchSwitchView
}

export async function removeMemory(id: string): Promise<void> {
  const response = await fetch(`/api/memories/${id}`, { method: "DELETE", headers: JSON_HEADERS, body: "{}" })
  if (!response.ok) throw await errorOf(response)
}

/**
 * Manda un pedido que corre un turno y entrega sus eventos a medida que llegan. Si el servidor no lo acepta (409,
 * 400…), lanza `ApiError` antes del primer evento. Devuelve true si el stream terminó normalmente.
 */
export async function streamTurn(path: string, body: unknown, onEvent: (event: UiEvent) => void, signal?: AbortSignal): Promise<void> {
  const response = await fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body), signal })
  if (!response.ok || !response.body) throw await errorOf(response)
  for await (const event of readSse(response.body)) onEvent(event)
}
