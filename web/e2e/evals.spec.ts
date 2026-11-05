import { randomUUID } from "node:crypto"
import { expect, test, type Page } from "@playwright/test"
import { sql } from "./helpers"

// Fase 11 (CA8): las evaluaciones en la web. Las corridas se lanzan desde la terminal y gastan modelo; acá se cargan
// dos corridas sintéticas en la base (y la traza de un caso), así la prueba no depende de lo que haya ni gasta API.
// Se borran al terminar.

const label = `e2e-${Date.now().toString(36)}`
const runA = randomUUID()
const runB = randomUUID()
const traceId = randomUUID()

async function insertRun(id: string, name: string, minutesAgo: number, results: { caseId: string; category: string; passed: boolean; detail: string; trace?: string }[]) {
  const passed = results.filter((r) => r.passed).length
  await sql(
    `INSERT INTO observability.eval_runs (id, label, started_at, duration_ms, models, prompts, runs, passed, total, input_tokens, output_tokens, cost_usd)
     VALUES ($1, $2, now() - make_interval(mins => $3), 9000, $4, 'actuales', 1, $5, $6, 8000, 400, 0.002)`,
    [id, name, minutesAgo, JSON.stringify({ agent: "claude-haiku-5-5", router: "claude-haiku-5-5", report: "claude-haiku-5-5" }), passed, results.length],
  )
  for (const r of results) {
    await sql(
      `INSERT INTO observability.eval_results (run_id, case_id, category, run_no, passed, checks, error, reply, input_tokens, output_tokens, cost_usd, duration_ms, trace_id)
       VALUES ($1, $2, $3, 1, $4, $5, NULL, $6, 4000, 200, 0.001, 3000, $7)`,
      [id, r.caseId, r.category, r.passed, JSON.stringify([{ check: "route", ok: r.passed, detail: r.detail }]), `respuesta de ${r.caseId}`, r.trace ?? null],
    )
  }
}

test.beforeAll(async () => {
  await insertRun(runA, `${label} A`, 10, [
    { caseId: "Q1", category: "consultas", passed: true, detail: "ruta query" },
    { caseId: "X1", category: "pedidos mixtos", passed: true, detail: "ruta action → query" },
  ])
  await insertRun(runB, `${label} B`, 5, [
    { caseId: "Q1", category: "consultas", passed: true, detail: "ruta query" },
    { caseId: "X1", category: "pedidos mixtos", passed: false, detail: "ruta esperada action → query, fue action", trace: traceId },
  ])
  await sql(
    `INSERT INTO observability.traces (id, thread_id, kind, input, started_at, duration_ms, status, route, calls, input_tokens, output_tokens, cost_usd, retries, eval_run_id, eval_case_id, spans)
     VALUES ($1, $2, 'new', 'Registrá la venta de un gel y decime cuánto stock queda.', now(), 3000, 'ok', '{action}', 1, 4000, 200, 0.001, 0, $3, 'X1', $4)`,
    [traceId, `eval-${label}-x1-1`, runB, JSON.stringify([{ id: "r", kind: "turn", name: "turno", start: 0, duration: 3000, status: "ok" }, { id: "n", parentId: "r", kind: "node", name: "router", start: 10, duration: 900, status: "ok" }])],
  )
})
test.afterAll(async () => {
  await sql(`DELETE FROM observability.traces WHERE id = $1`, [traceId])
  await sql(`DELETE FROM observability.eval_runs WHERE id = ANY($1)`, [[runA, runB]])
})

let pageErrors: string[] = []
test.beforeEach(({ page }) => {
  pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
})
test.afterEach(() => expect(pageErrors, "errores en la página").toEqual([]))

const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)

test("la lista, el informe de una corrida (con la traza del caso que falló) y la comparación de dos", async ({ page }) => {
  await page.goto("/evals")
  await expect(page.getByTestId("eval-run-row").filter({ hasText: `${label} A` })).toBeVisible()
  await expect(page.getByTestId("eval-run-row").filter({ hasText: `${label} B` })).toBeVisible()

  // El informe de B: por categoría, y el caso que falló viene abierto, con su regla y su traza.
  await page.getByRole("link", { name: `${label} B` }).click()
  await expect(page.getByTestId("eval-categories")).toContainText("pedidos mixtos")
  await expect(page.getByTestId("eval-categories").getByRole("meter")).toHaveCount(2)
  const failed = page.getByTestId("eval-case").filter({ hasText: "X1" })
  await expect(failed).toContainText("ruta esperada action → query, fue action")
  await failed.getByRole("link", { name: "Ver traza" }).click()
  await expect(page.getByTestId("trace-timeline")).toBeVisible()
  await expect(page.locator("main")).toContainText("Caso X1 de una corrida de evaluación")

  // Comparar A (antes) con B (después) desde el formulario.
  await page.goto("/evals")
  await page.getByLabel("Antes (A)").selectOption(runA)
  await page.getByLabel("Después (B)").selectOption(runB)
  await page.getByRole("button", { name: "Comparar" }).click()
  await expect(page).toHaveURL(new RegExp(`a=${runA}&b=${runB}`))
  const changed = page.getByTestId("eval-changed")
  await expect(changed.getByRole("listitem")).toHaveCount(1)
  await expect(changed).toContainText("X1")
  await expect(changed).toContainText("empeoró")
  await expect(page.getByTestId("eval-compare-categories")).toContainText("consultas")

  // Tema oscuro y celular.
  await page.emulateMedia({ colorScheme: "dark" })
  await page.setViewportSize({ width: 390, height: 800 })
  await noOverflow(page)
  await page.goto(`/evals/${runB}`)
  await noOverflow(page)
})
