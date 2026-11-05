import { expect, test, type Page } from "@playwright/test"
import { timeTravelCases } from "../../evals/resilience-cases"
import { actionsOf, ask, cleanup, framesOf, newThreadId, recordTimeline, sql } from "./helpers"

// Escenarios congelados F4 a F6 (specs/fase-10-errores-reintentos.md): editar y reintentar desde la web, con el modelo
// real y la base real. F5 aprueba un turno: lo que crea se borra al final por el registro de acciones de su hilo.

const CASES = Object.fromEntries(timeTravelCases().map((c) => [c.id, c]))
const AR = `'America/Argentina/Buenos_Aires'`
const threads: string[] = []
test.afterAll(async () => cleanup(threads))

let pageErrors: string[] = []
test.beforeEach(({ page }) => {
  pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
})
test.afterEach(() => expect(pageErrors, "errores en la página").toEqual([]))

async function openNewThread(page: Page) {
  const id = newThreadId()
  threads.push(id)
  await page.goto(`/threads/${id}`)
  await expect(page.getByLabel("Mensaje para el copiloto")).toBeEnabled()
  return id
}

const messages = (page: Page) => page.getByRole("region", { name: "Messages" })
const card = (page: Page) => page.getByRole("region", { name: "Acción para aprobar" })
const ready = (page: Page) => expect(page.getByText("Listo", { exact: true })).toBeVisible()
const lastReply = (page: Page) => page.getByTestId("copilot-text").last()
const marker = (page: Page) => page.getByTestId("branch-marker")

/** «Editar» en un mensaje de la persona (aparece al pasar el mouse), el texto nuevo y «Volver a preguntar». */
async function editMessage(page: Page, original: string, text: string) {
  await messages(page).getByText(original, { exact: true }).hover()
  await messages(page).getByRole("button", { name: "Editar", exact: true }).click()
  await page.getByLabel("Editar el mensaje").fill(text)
  await page.getByRole("button", { name: "Volver a preguntar" }).click()
}

/** ¿Algún checkpoint o escritura del hilo guarda este texto? (la historia de LangGraph, con todas sus ramas) */
async function historyHas(threadId: string, text: string) {
  const rows = await sql<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM langgraph.checkpoint_blobs WHERE thread_id = $1 AND position(convert_to($2, 'UTF8') IN blob) > 0)
          + (SELECT COUNT(*) FROM langgraph.checkpoint_writes WHERE thread_id = $1 AND position(convert_to($2, 'UTF8') IN blob) > 0) AS n`,
    [threadId, text],
  )
  return Number(rows[0]!.n) > 0
}

/** Quita separadores de miles: "1.569" → "1569". */
const digits = (text: string) => text.replace(/(?<=\d)[.\s](?=\d{3}\b)/g, "")

test("F4: editar «mañana» a «pasado mañana»: la respuesta nueva, la marca, y al recargar sigue la rama nueva (CA4)", async ({ page }) => {
  const f4 = CASES.F4!
  if (f4.step.kind !== "edit") throw new Error("F4 edita")
  const id = await openNewThread(page)
  await ask(page, f4.message)
  await ready(page)

  await editMessage(page, f4.message, f4.step.text)
  await ready(page)
  await expect(marker(page)).toContainText("Editaste este mensaje")
  await expect(messages(page).getByText(f4.message, { exact: true })).toHaveCount(0)
  // La cantidad de pasado mañana, la misma que da SQL (y que daría un hilo aparte).
  const [{ n }] = await sql<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM appointments
     WHERE (starts_at AT TIME ZONE ${AR})::date = (now() AT TIME ZONE ${AR})::date + 2 AND status <> 'cancelled'`,
  )
  expect(digits(await lastReply(page).innerText())).toMatch(new RegExp(`\\b${n}\\b`))

  await page.reload()
  await expect(messages(page).getByText(f4.step.text, { exact: true })).toBeVisible()
  await expect(messages(page).getByText(f4.message, { exact: true })).toHaveCount(0)
  expect(await historyHas(id, f4.message), "la historia conserva el mensaje original").toBe(true)
})

test("F5: editar un turno ya aprobado propone de nuevo (16 h) sin ejecutar; el de las 15 existe una sola vez (CA4, R13)", async ({ page }) => {
  const f5 = CASES.F5!
  if (f5.step.kind !== "approve-then-edit") throw new Error("F5 aprueba y edita")
  const id = await openNewThread(page)
  await ask(page, f5.message)
  await expect(card(page)).toBeVisible()
  await card(page).getByRole("button", { name: "Aprobar" }).click()
  await ready(page)
  await expect(page.getByText("Resultado de la acción")).toBeVisible()

  await editMessage(page, f5.message, f5.step.text)
  await expect(card(page)).toBeVisible()
  await expect(card(page)).toContainText(f5.expected.proposesTime!)
  await expect(marker(page)).toContainText("Lo que ya se había hecho no se deshace")
  let logged = await actionsOf(id)
  expect(logged.map((a) => a.decision), "la rama nueva no ejecuta nada sin aprobar").toEqual(["approved"])

  await card(page).getByRole("button", { name: "Rechazar" }).click()
  await page.getByRole("button", { name: "Rechazar la acción" }).click()
  await ready(page)
  logged = await actionsOf(id)
  expect(logged.map((a) => a.decision)).toEqual(["approved", "rejected"])
  const executed = logged.filter((a) => a.payload.result?.appointmentId)
  expect(executed, "el turno de las 15 se creó una sola vez").toHaveLength(1)
  expect(executed[0]!.payload.result?.startsAt).toContain(f5.expected.executedOnceAt!)
})

test("F6: «Reintentar» vuelve a correr el turno en vivo, sin duplicar el mensaje de la persona (CA4)", async ({ page }) => {
  const f6 = CASES.F6!
  await openNewThread(page)
  await ask(page, f6.message)
  await ready(page)

  // «Respondiendo» es la etiqueta del estado de la página mientras corre el turno.
  await recordTimeline(page, ["Respondiendo"])
  await messages(page).getByRole("button", { name: "Reintentar" }).click()
  await ready(page)
  await expect(marker(page)).toContainText("Reintentaste este turno")
  // En vivo: el texto de la respuesta nueva ya se ve mientras el turno sigue corriendo (una respuesta corta puede
  // llegar en dos o tres pedazos, así que no se cuenta cuántos).
  const frames = await framesOf(page)
  expect(frames.some((f) => f.replyLength > 0 && f.seen.includes("Respondiendo")), "la respuesta llega antes de que termine el turno").toBe(true)
  await expect(lastReply(page)).toContainText(/cera mate/i)
  await expect(messages(page).getByText(f6.message, { exact: true })).toHaveCount(1)

  await page.reload()
  await expect(messages(page).getByText(f6.message, { exact: true })).toHaveCount(1)
  await expect(page.getByTestId("copilot-text")).toHaveCount(1)
})
