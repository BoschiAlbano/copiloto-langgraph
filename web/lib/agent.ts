import "server-only"
import { existsSync } from "node:fs"
import path from "node:path"
import { parseEnv } from "@copilot/config/env"
import { createAgent, type Agent } from "@copilot/graph/create-agent"
import { listThreads } from "@copilot/graph/threads"
import { makeHandlers, type WebHandlers } from "@copilot/web/handlers"

// Un solo agente por proceso (pools de Postgres incluidos), y los handlers con su registro de turnos en curso. En
// desarrollo, el recargado en caliente vuelve a evaluar los módulos: se guardan en globalThis para no abrir pools nuevos.
const cache = globalThis as typeof globalThis & { __copilot?: { agent: Agent; handlers: WebHandlers } }

/** El .env es el de la raíz del repositorio, el mismo que usa la terminal. `npm run web` corre con cwd en web/. */
function loadRootEnv() {
  const file = path.join(process.cwd(), "..", ".env")
  if (existsSync(file)) process.loadEnvFile(file)
  return parseEnv(process.env)
}

function init() {
  const agent = createAgent(loadRootEnv())
  const handlers = makeHandlers({
    graph: agent.graph,
    traces: agent.traces,
    listThreads: () => listThreads({ pool: agent.pool, graph: agent.graph }),
    memory: agent.memory,
  })
  return { agent, handlers }
}

export function getHandlers(): WebHandlers {
  cache.__copilot ??= init()
  return cache.__copilot.handlers
}
