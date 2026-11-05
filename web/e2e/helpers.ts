import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import pg from "pg"
import type { Page } from "@playwright/test"

// Ayudas de las pruebas de punta a punta (fase 9). Las pruebas usan hilos `e2e-…`: al terminar se borran esos hilos y lo
// que sus acciones aprobadas escribieron (por el registro de acciones), sin tocar los hilos ni las memorias reales.

const envFile = fileURLToPath(new URL("../../.env", import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

const CHECKPOINT_SCHEMA = "langgraph"

export const newThreadId = () => `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Una consulta con el dueño de la base (solo para comprobar y limpiar). */
export async function sql<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_WRITE })
  await client.connect()
  try {
    return (await client.query<T>(text, values)).rows
  } finally {
    await client.end()
  }
}

export interface LoggedAction {
  decision: string
  payload: { result?: { appointmentId?: number; startsAt?: string }; final?: Record<string, unknown> | null }
}

/** Lo que quedó en el registro de acciones para un hilo. */
export const actionsOf = (threadId: string) =>
  sql<LoggedAction>(`SELECT decision, payload FROM action_log WHERE thread_id = $1 ORDER BY id`, [threadId])

/** Borra lo que escribieron los hilos de prueba (turnos creados, registro de acciones) y los hilos mismos. */
export async function cleanup(threadIds: string[]) {
  if (threadIds.length === 0) return
  await sql(
    `DELETE FROM appointments WHERE id IN (
       SELECT (payload->'result'->>'appointmentId')::int FROM action_log
        WHERE thread_id = ANY($1) AND action = 'createAppointment' AND payload->'result'->>'appointmentId' IS NOT NULL)`,
    [threadIds],
  )
  await sql(`DELETE FROM action_log WHERE thread_id = ANY($1)`, [threadIds])
  for (const table of ["checkpoint_writes", "checkpoint_blobs", "checkpoints"]) {
    await sql(`DELETE FROM "${CHECKPOINT_SCHEMA}".${table} WHERE thread_id = ANY($1)`, [threadIds])
  }
  // Desde la fase 11, cada turno deja su traza.
  await sql(`DELETE FROM observability.traces WHERE thread_id = ANY($1)`, [threadIds]).catch(() => undefined)
}

export async function ask(page: Page, text: string) {
  const box = page.getByLabel("Mensaje para el copiloto")
  await box.fill(text)
  await box.press("Enter")
}

export interface Frame {
  t: number
  /** Largo del texto de la última respuesta del copiloto. */
  replyLength: number
  /** Qué marcas de texto estaban en la página en ese momento. */
  seen: string[]
}

/**
 * Graba cómo cambia la página mientras corre un turno: el largo de la última respuesta y qué textos de interés ya
 * aparecieron. Sirve para comprobar el ORDEN (la herramienta antes que la respuesta) y que la respuesta crece de a poco.
 */
export async function recordTimeline(page: Page, marks: string[]) {
  await page.evaluate((marks) => {
    const w = window as unknown as { __frames: Frame[] }
    w.__frames = []
    const start = performance.now()
    const snap = () => {
      const replies = document.querySelectorAll('[data-testid="copilot-text"]')
      const last = replies[replies.length - 1]
      const text = document.body.innerText
      w.__frames.push({ t: performance.now() - start, replyLength: last?.textContent?.length ?? 0, seen: marks.filter((m) => text.includes(m)) })
    }
    new MutationObserver(snap).observe(document.body, { subtree: true, childList: true, characterData: true })
  }, marks)
}

export const framesOf = (page: Page) => page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames)

/** El primer cuadro en que aparece una marca (o -1). */
export const firstSeen = (frames: Frame[], mark: string) => frames.findIndex((f) => f.seen.includes(mark))
