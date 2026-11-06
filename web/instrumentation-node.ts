import { existsSync } from "node:fs"
import path from "node:path"
import { parseEnv } from "@copilot/config/env"

// La validación de la configuración al arrancar (ver instrumentation.ts). El .env es el de la raíz del repositorio,
// como en lib/agent.ts.
const file = path.join(process.cwd(), "..", ".env")
if (existsSync(file)) process.loadEnvFile(file)
try {
  parseEnv(process.env)
} catch (error) {
  console.error(`\n✗ ${(error as Error).message}\n`)
  process.exit(1)
}
