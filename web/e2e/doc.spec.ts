import { expect, test } from "@playwright/test"

// La documentación en la web (specs/doc-web.md, CA1 a CA4). No usa el modelo ni escribe nada.

let problems: string[] = []
test.beforeEach(({ page }) => {
  problems = []
  page.on("pageerror", (error) => problems.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text())
  })
})
test.afterEach(() => expect(problems, "errores en la página o en la consola").toEqual([]))

test("CA1: la portada lista las fases con su estado y objetivo, y cada una abre su página", async ({ page }) => {
  await page.goto("/doc")
  const cards = page.getByRole("main").getByRole("listitem").filter({ has: page.getByText(/^Fase \d+$/) })
  expect(await cards.count()).toBeGreaterThanOrEqual(9)
  await expect(cards.first()).toContainText("terminada")
  await expect(cards.first()).toContainText("Tener el entorno listo")
  await cards.first().getByRole("link").click()
  await expect(page).toHaveURL(/\/doc\/fase-01$/)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Entorno y primer grafo")
  for (const slug of ["inicio", "plan", "mapa-del-grafo", "doc-web", "fase-09"]) {
    const response = await page.goto(`/doc/${slug}`)
    expect(response?.status(), slug).toBe(200)
    await expect(page.getByRole("heading", { level: 1 })).not.toBeEmpty()
  }
})

for (const scheme of ["light", "dark"] as const) {
  test(`CA2: los diagramas se dibujan como SVG (tema ${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto("/doc/fase-08")
    const diagrams = page.getByTestId("mermaid-diagram")
    await expect(diagrams).toHaveCount(4)
    for (let i = 0; i < 4; i++) {
      await expect(diagrams.nth(i)).toHaveAttribute("data-rendered", "true")
      await expect(diagrams.nth(i).locator("svg").first()).toBeVisible()
    }
    // El código de un diagrama no queda a la vista.
    await expect(page.getByText("flowchart TD", { exact: false })).toHaveCount(0)
    // Ampliar uno.
    await diagrams.first().hover()
    await diagrams.first().getByRole("button", { name: "Ampliar el diagrama" }).click()
    await expect(page.getByRole("dialog").locator("svg").first()).toBeVisible()
  })
}

test("CA3: el índice lleva a cada título; anterior y siguiente recorren las fases; los links entre documentos van a /doc", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/doc/fase-07")
  const toc = page.getByRole("navigation", { name: "En esta página" })
  await toc.getByRole("link", { name: "Qué aprendí" }).click()
  await expect(page).toHaveURL(/#qué-aprendí$|#qu%C3%A9-aprend%C3%AD$/)
  await expect(page.getByRole("heading", { level: 2, name: "Qué aprendí" })).toBeInViewport()

  const pager = page.getByRole("navigation", { name: "Anterior y siguiente" })
  await pager.getByRole("link", { name: /Siguiente/ }).click()
  await expect(page).toHaveURL(/\/doc\/fase-08$/)
  await pager.getByRole("link", { name: /Anterior/ }).click()
  await expect(page).toHaveURL(/\/doc\/fase-07$/)

  // El índice entra en la pantalla (el contenido no ensancha la página).
  const width = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(width).toBeLessThanOrEqual(1440)
})

test("CA4: un nombre fuera de la lista da 404", async ({ page }) => {
  for (const slug of ["fase-99", "..%2F.env", "README.md", "specs%2Ffase-01-entorno.md"]) {
    const response = await page.goto(`/doc/${slug}`)
    expect(response?.status(), slug).toBe(404)
  }
  // El 404 de Next registra el pedido fallido en la consola, y en desarrollo React avisa que el script del tema
  // (next-themes) se vuelve a dibujar en el navegador en esa página: ninguno es un error de la documentación.
  problems = problems.filter((p) => !/404/.test(p) && !/Encountered a script tag/.test(p))
})

test("R7: del chat a la documentación y de vuelta", async ({ page }) => {
  await page.goto("/threads/e2e-doc-link")
  await page.getByRole("link", { name: "Documentación" }).click()
  await expect(page).toHaveURL(/\/doc$/)
  await page.getByRole("link", { name: "Ir al chat" }).click()
  await expect(page).toHaveURL(/\/threads\//)
})
