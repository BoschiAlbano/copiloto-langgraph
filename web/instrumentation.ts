// Al arrancar el servidor de la web (fase 12, R4): si falta una variable de entorno o es inválida, no arranca y dice
// cuál, en vez de fallar recién en el primer pedido. El .env es el de la raíz del repositorio, como en lib/agent.ts.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { existsSync } = await import("node:fs")
  const path = await import("node:path")
  const { parseEnv } = await import("@copilot/config/env")
  const file = path.join(process.cwd(), "..", ".env")
  if (existsSync(file)) process.loadEnvFile(file)
  try {
    parseEnv(process.env)
  } catch (error) {
    console.error(`\n✗ ${(error as Error).message}\n`)
    process.exit(1)
  }
}
