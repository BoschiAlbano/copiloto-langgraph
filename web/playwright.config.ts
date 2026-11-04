import { defineConfig, devices } from "@playwright/test"

// Escenarios W1 a W5 de la fase 9 (evals/web-cases.ts) en un navegador real, con el modelo real (centavos de Haiku).
// Levanta `npm run dev` si no está corriendo. Uno a la vez: comparten la base y el agente.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 90_000 },
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3000", trace: "retain-on-failure", locale: "es-AR" },
  webServer: { command: "npm run dev", url: "http://127.0.0.1:3000/api/memories", reuseExistingServer: true, timeout: 240_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } }],
})
