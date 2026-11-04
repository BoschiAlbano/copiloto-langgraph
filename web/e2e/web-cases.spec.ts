import { expect, test } from "@playwright/test"
import { webCases } from "../../evals/web-cases"
import { actionsOf, ask, cleanup, firstSeen, framesOf, newThreadId, recordTimeline } from "./helpers"

// Escenarios congelados W1 a W5 (specs/fase-09-streaming-web.md), con el modelo real y la base real.
// W3 y W4 aprueban un turno: lo que crean se borra al final por el registro de acciones de sus hilos.

const CASES = Object.fromEntries(webCases().map((c) => [c.id, c]))
const threads: string[] = []
test.afterAll(async () => cleanup(threads))

// Ningún error en la página (por ejemplo, que el HTML del servidor no coincida con el del navegador).
let pageErrors: string[] = []
test.beforeEach(({ page }) => {
  pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
})
test.afterEach(() => expect(pageErrors, "errores en la página").toEqual([]))

async function openNewThread(page: import("@playwright/test").Page) {
  const id = newThreadId()
  threads.push(id)
  await page.goto(`/threads/${id}`)
  await expect(page.getByLabel("Mensaje para el copiloto")).toBeEnabled()
  return id
}

const card = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "Acción para aprobar" })
const ready = (page: import("@playwright/test").Page) => expect(page.getByText("Listo", { exact: true })).toBeVisible()

test("W1: la herramienta se ve antes que la respuesta, y la respuesta aparece de a poco (CA1, CA2)", async ({ page }) => {
  const w1 = CASES.W1!
  await openNewThread(page)
  await recordTimeline(page, ["Agenda de turnos", "Plan: consulta"])
  await ask(page, w1.message)
  await ready(page)

  const frames = await framesOf(page)
  const tool = firstSeen(frames, "Agenda de turnos")
  const firstText = frames.findIndex((f) => f.replyLength > 0)
  expect(firstSeen(frames, "Plan: consulta"), "la ruta se ve").toBeGreaterThanOrEqual(0)
  expect(tool, "la herramienta se ve").toBeGreaterThanOrEqual(0)
  expect(tool, "la herramienta aparece ANTES que el texto de la respuesta").toBeLessThan(firstText)
  // Progresivo: el texto de la respuesta tuvo varios largos distintos antes del final.
  const lengths = [...new Set(frames.map((f) => f.replyLength).filter((n) => n > 0))]
  expect(lengths.length, `largos vistos: ${lengths.join(", ")}`).toBeGreaterThanOrEqual(w1.expected.progressiveSteps!)
  const firstAt = frames[firstText]!.t
  const lastAt = frames.findLast((f) => f.replyLength > 0)!.t
  test.info().annotations.push({ type: "tiempos", description: `primer texto a los ${Math.round(firstAt)} ms, último cambio a los ${Math.round(lastAt)} ms` })
})

test("W2: la tarjeta bloquea la entrada; rechazar con motivo no escribe nada (CA3)", async ({ page }) => {
  const w2 = CASES.W2!
  const id = await openNewThread(page)
  await ask(page, w2.message)
  await expect(card(page)).toBeVisible()
  await expect(card(page)).toContainText("15:00")
  await expect(card(page)).toContainText(String(w2.expected.cardParams!.date))
  await expect(page.getByLabel("Mensaje para el copiloto")).toBeDisabled()

  await card(page).getByRole("button", { name: "Rechazar" }).click()
  await page.getByLabel("Motivo (opcional)").fill("mejor otro día")
  await page.getByRole("button", { name: "Rechazar la acción" }).click()
  await ready(page)
  await expect(page.getByText("Rechazaste la acción: «mejor otro día».")).toBeVisible()
  await expect(card(page)).toHaveCount(0)

  const logged = await actionsOf(id)
  expect(logged.map((a) => a.decision)).toEqual(["rejected"])
  expect(logged[0]!.payload.result).toBeUndefined()
})

test("W3: editar la hora no ejecuta; la tarjeta nueva dice 16 y al aprobar se crea el turno a las 16 (CA3)", async ({ page }) => {
  const w3 = CASES.W3!
  const id = await openNewThread(page)
  await ask(page, w3.message)
  await expect(card(page)).toBeVisible()

  await card(page).getByRole("button", { name: "Editar" }).click()
  await page.getByLabel("Hora").fill("16:00")
  await page.getByRole("button", { name: "Ver la tarjeta con los cambios" }).click()
  await expect(card(page).getByText("Editada")).toBeVisible()
  await expect(card(page)).toContainText("16:00")
  expect(await actionsOf(id), "editar no ejecuta nada").toEqual([])

  await card(page).getByRole("button", { name: "Aprobar" }).click()
  await ready(page)
  await expect(page.getByText("Resultado de la acción")).toBeVisible()
  const logged = await actionsOf(id)
  // La fase 5 registra «edited» cuando se aprueba una propuesta editada (y guarda lo propuesto y lo final).
  expect(logged.map((a) => a.decision)).toEqual(["edited"])
  expect(logged[0]!.payload.result?.startsAt).toContain(`${w3.expected.cardParams!.date}T16:00`)
})

test("W4: recargar con la tarjeta abierta la vuelve a mostrar; aprobar crea el turno una sola vez (CA3, CA4)", async ({ page }) => {
  const w4 = CASES.W4!
  const id = await openNewThread(page)
  await ask(page, w4.message)
  await expect(card(page)).toBeVisible()

  await page.reload()
  await expect(page.getByRole("region", { name: "Messages" }).getByText(w4.message)).toBeVisible() // la conversación
  await expect(card(page)).toBeVisible() // y la misma tarjeta
  await expect(card(page)).toContainText("15:00")
  await expect(page.getByText("Espera tu decisión", { exact: true })).toBeVisible()

  await card(page).getByRole("button", { name: "Aprobar" }).click()
  await ready(page)
  const logged = await actionsOf(id)
  expect(logged.map((a) => a.decision)).toEqual(["approved"])
  expect(logged[0]!.payload.result?.startsAt).toContain(`${w4.expected.cardParams!.date}T15:00`)
})

test("W5: las tres secciones se ven terminadas antes que el reporte (CA2)", async ({ page }) => {
  const w5 = CASES.W5!
  await openNewThread(page)
  const marks = ["Sección ventas: lista", "Sección turnos: lista", "Sección stock: lista"]
  await recordTimeline(page, marks)
  await ask(page, w5.message)
  await ready(page)
  const frames = await framesOf(page)
  const report = frames.findIndex((f) => f.replyLength > 0)
  for (const mark of marks) {
    const at = firstSeen(frames, mark)
    expect(at, mark).toBeGreaterThanOrEqual(0)
    expect(at, `${mark} antes que el reporte`).toBeLessThan(report)
  }
  await expect(page.getByTestId("copilot-text").last()).toContainText(/ventas/i)
})

test("corte: recargar en medio de una respuesta deja el turno a medias y «Continuar» lo termina (CA4, CA8)", async ({ page }) => {
  await openNewThread(page)
  await ask(page, "Armame el resumen del mes pasado y contame qué te llama la atención.")
  await expect(page.getByText(/^Trabajando/)).toBeVisible()
  await page.reload()
  await expect(page.getByText("El último turno quedó a medias")).toBeVisible()
  await expect(page.getByLabel("Mensaje para el copiloto")).toBeDisabled()
  await page.getByRole("button", { name: "Continuar" }).click()
  await ready(page)
  await expect(page.getByText("El último turno quedó a medias")).toHaveCount(0)
  await expect(page.getByTestId("copilot-text").last()).not.toBeEmpty()
})
