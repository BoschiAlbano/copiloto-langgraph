import { expect, test, type Page } from "@playwright/test"
import { branchCases } from "../../evals/branch-cases"
import { actionsOf, ask, cleanup, newThreadId } from "./helpers"

// Escenarios congelados B1 a B4 (specs/ramas-del-hilo.md): las versiones de la conversación, con el modelo real y la
// base real. B4 aprueba un turno: lo que crea se borra al final por el registro de acciones de su hilo. El navegador
// de las pruebas es de 1280 px: el panel es una columna a la derecha.

const CASES = Object.fromEntries(branchCases().map((c) => [c.id, c]))
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
const panel = (page: Page) => page.getByRole("complementary", { name: "Versiones de la conversación" })
const version = (page: Page, n: number) => panel(page).getByTestId(`branch-${n}`)
const card = (page: Page) => page.getByRole("region", { name: "Acción para aprobar" })
const ready = (page: Page) => expect(page.getByText("Listo", { exact: true })).toBeVisible()

async function showPanel(page: Page) {
  if (!(await panel(page).isVisible())) await page.getByRole("button", { name: "Versiones de la conversación" }).click()
  await expect(panel(page)).toBeVisible()
}

/** Lo que el panel tiene que mostrar al final de un escenario. */
async function expectPanel(page: Page, expected: { branches: number; current: { version: number; label: string } }) {
  await showPanel(page)
  await expect(panel(page).getByTestId(/^branch-\d+$/)).toHaveCount(expected.branches)
  await expect(version(page, expected.current.version)).toHaveAttribute("aria-current", "true")
  await expect(version(page, expected.current.version)).toContainText(expected.current.label)
}

async function expectHumanMessages(page: Page, texts: string[]) {
  for (const text of texts) await expect(messages(page).getByText(text, { exact: true })).toHaveCount(1)
}

test("B1 a B3: editar crea la versión 2; abrir la 1 la retoma (también al recargar) y el modelo sigue desde ahí", async ({ page }) => {
  const [b1, b2, b3] = [CASES.B1!, CASES.B2!, CASES.B3!]
  const [first, editStep] = b1.steps
  if (first?.kind !== "ask" || editStep?.kind !== "edit") throw new Error("B1 pregunta y edita")
  await openNewThread(page)

  // B1
  await ask(page, first.text)
  await ready(page)
  await messages(page).getByText(editStep.original, { exact: true }).hover()
  await messages(page).getByRole("button", { name: "Editar", exact: true }).click()
  await page.getByLabel("Editar el mensaje").fill(editStep.text)
  await page.getByRole("button", { name: "Volver a preguntar" }).click()
  await ready(page)
  await expectPanel(page, b1.expected)
  await expect(version(page, 1)).toContainText(first.text)
  await expectHumanMessages(page, b1.expected.humanMessages!)

  // B2: abrir la 1, y recargar.
  await version(page, 1).click()
  await expect(version(page, 1)).toHaveAttribute("aria-current", "true")
  await expectHumanMessages(page, b2.expected.humanMessages!)
  await expect(messages(page).getByText(editStep.text, { exact: true })).toHaveCount(0)
  await page.reload()
  await expectHumanMessages(page, b2.expected.humanMessages!)
  await expectPanel(page, b2.expected)

  // B3: el modelo ve la versión abierta.
  const b3Ask = b3.steps[0]
  if (b3Ask?.kind !== "ask") throw new Error("B3 pregunta")
  await ask(page, b3Ask.text)
  await ready(page)
  const reply = await page.getByTestId("copilot-text").last().innerText()
  expect(reply, "trae la pregunta de la versión 1").toMatch(b3.expected.reply!.includes)
  expect(reply, "no trae la de la versión 2").not.toMatch(b3.expected.reply!.excludes)
  await expectHumanMessages(page, b3.expected.humanMessages!)
  await expectPanel(page, b3.expected)
  await expect(version(page, 1)).toContainText("4 mensajes")
})

test("B4: una acción aprobada y un reintento que ya no puede agendar; abrir la versión 1 no ejecuta nada y el turno existe una vez", async ({ page }) => {
  const b4 = CASES.B4!
  const book = b4.steps[0]
  if (book?.kind !== "ask") throw new Error("B4 pide un turno")
  const id = await openNewThread(page)
  await ask(page, book.text)
  await expect(card(page)).toBeVisible()
  await card(page).getByRole("button", { name: "Aprobar" }).click()
  await ready(page)
  await expect(page.getByText("Resultado de la acción")).toBeVisible()

  // Reintentar: la base no cambió de rama, así que el turno de las 15 ya existe y la validación lo frena (sin tarjeta).
  await messages(page).getByRole("button", { name: "Reintentar" }).click()
  await ready(page)
  await expect(page.getByText("La acción no se pudo hacer")).toBeVisible()
  await expect(card(page)).toHaveCount(0)
  const logged = (await actionsOf(id)).map((a) => a.decision)
  expect(logged).toEqual(b4.expected.loggedDecisions)

  // Las dos versiones empiezan con el mismo mensaje; la 1 ejecutó la acción.
  await showPanel(page)
  await expect(version(page, 1)).toContainText(book.text)
  await expect(version(page, 2)).toContainText(book.text)
  await expect(version(page, b4.expected.markedExecuted!)).toContainText("Ejecutó una acción")
  await version(page, 1).click()
  await expectPanel(page, b4.expected)
  await expectHumanMessages(page, [book.text])

  const after = await actionsOf(id)
  expect(after.map((a) => a.decision), "abrir una versión no cambia el registro").toEqual(b4.expected.loggedDecisions)
  const executed = after.filter((a) => a.payload.result?.appointmentId)
  expect(executed, "el turno se creó una sola vez").toHaveLength(1)
  expect(executed[0]!.payload.result?.startsAt).toContain(b4.expected.executedOnceAt!)
})
