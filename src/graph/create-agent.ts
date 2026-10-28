import type { Env } from "../config/env.js";
import { createPrisma } from "../db/client.js";
import { makeReadTools } from "../tools/index.js";
import { buildGraph } from "./index.js";
import { claude, makeClarifyModel, makeRouterModel } from "./models.js";

export type Agent = ReturnType<typeof createAgent>;

/**
 * Arma el copiloto real:
 * - router y aclaración: modelo barato (MODEL_ROUTER); el router con salida estructurada;
 * - agente: MODEL_AGENT con herramientas de lectura sobre la base con el rol copilot_reader;
 * - charla: MODEL_AGENT sin herramientas.
 */
export function createAgent(env: Env) {
  const db = createPrisma(env.DATABASE_URL_READ);
  const tools = makeReadTools(db);

  const graph = buildGraph({
    models: {
      router: makeRouterModel(env),
      agent: claude(env, env.MODEL_AGENT).bindTools(tools),
      chat: claude(env, env.MODEL_AGENT),
      clarify: makeClarifyModel(env),
    },
    tools,
  });
  return { graph, close: () => db.$disconnect() };
}
