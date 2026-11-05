import { expect, test, type Page } from "@playwright/test"
import { ask, cleanup, newThreadId } from "./helpers"

// Fase 11 (CA3): las trazas en la web, con el modelo real. El hilo y su traza se borran al terminar.

const threads: string[] = []
test.afterAll(async () => cleanup(threads))

let pageErrors: string[] = []
test.beforeEach(({ page }) => {
  pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
})
test.afterEach(() => expect(pageErrors, "errores en la página").toEqual([]))

const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)

test("«Ver traza» abre la línea de tiempo del turno: router, agente, herramienta y modelo, con los tokens del resumen", async ({ page }) => {
  const id = newThreadId()
  threads.push(id)
  await page.goto(`/threads/${id}`)
  await ask(page, "¿Cuánto stock queda de cera mate?")
  await expect(page.getByText("Listo", { exact: true })).toBeVisible()
  // El resumen del turno: «3 llamadas · 8.563 → 209 tokens · sesión …».
  const summary = await page.getByText(/llamadas? · .* tokens/).first().innerText()
  const turnTokens = summary.match(/([\d.]+ → [\d.]+) tokens/)![1]!

  await page.getByRole("link", { name: "Ver traza" }).click()
  const timeline = page.getByTestId("trace-timeline")
  await expect(timeline).toBeVisible()
  for (const step of ["router", "query_graph", "agent", "getStockLevels"]) await expect(timeline.getByText(step, { exact: true }).first()).toBeVisible()
  await expect(page.getByTestId("span-llm").first()).toBeVisible()
  await expect(page.locator("main")).toContainText(turnTokens)

  // La herramienta: sus argumentos y su resultado.
  await page.getByTestId("span-tool").first().click()
  await expect(page.getByTestId("span-detail")).toContainText("Argumentos")
  await expect(page.getByTestId("span-detail")).toContainText(/cera/i)

  // La lista: filtra por hilo y por errores.
  await page.getByRole("link", { name: "Otras trazas de este hilo" }).click()
  await expect(page.getByTestId("trace-row")).toHaveCount(1)
  await page.getByRole("link", { name: "Con errores" }).click()
  await expect(page.getByTestId("trace-row")).toHaveCount(0)
  await expect(page.getByText("Todavía no hay trazas con errores")).toBeVisible()

  // Tema oscuro y celular.
  await page.emulateMedia({ colorScheme: "dark" })
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto(`/traces?thread=${id}`)
  await page.getByTestId("trace-row").getByRole("link").click()
  await expect(page.getByTestId("trace-timeline")).toBeVisible()
  await noOverflow(page)
})
