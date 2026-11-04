import "server-only"
import { existsSync } from "node:fs"
import path from "node:path"
import { parseEnv } from "@copilot/config/env"
import { createAgent, type Agent } from "@copilot/graph/create-agent"

// Un solo agente por proceso (pools de Postgres incluidos). En desarrollo, el recargado en caliente vuelve a evaluar
// los módulos: el agente se guarda en globalThis para no abrir pools nuevos en cada cambio.
const cache = globalThis as typeof globalThis & { __copilotAgent?: Agent }

/** El .env es el de la raíz del repositorio, el mismo que usa la terminal. `npm run web` corre con cwd en web/. */
function loadRootEnv() {
  const file = path.join(process.cwd(), "..", ".env")
  if (existsSync(file)) process.loadEnvFile(file)
  return parseEnv(process.env)
}

export function getAgent(): Agent {
  cache.__copilotAgent ??= createAgent(loadRootEnv())
  return cache.__copilotAgent
}
