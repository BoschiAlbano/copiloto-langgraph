import type { Env } from "../config/env.js";
import { createPrisma } from "../db/client.js";
import { ACTION_DEFINITIONS } from "../tools/actions/definitions.js";
import { makeReadTools } from "../tools/index.js";
import { makeActionRunner } from "./action-runner.js";
import { createCheckpointing } from "./checkpointing.js";
import { buildGraph } from "./index.js";
import { claude, makeClarifyModel, makeRouterModel } from "./models.js";

export type Agent = ReturnType<typeof createAgent>;

/**
 * Arma el copiloto real, con un cliente de base de datos por rol:
 * - router y aclaración: modelo barato (MODEL_ROUTER); el router con salida estructurada;
 * - agente de consultas: MODEL_AGENT con herramientas de lectura (rol copilot_reader);
 * - agente de acciones: MODEL_AGENT con las mismas herramientas de lectura y las DEFINICIONES de las cuatro
 *   acciones. Las acciones se ejecutan solo tras una aprobación, con el rol copilot_actions;
 * - charla: MODEL_AGENT sin herramientas;
 * - hilos: el estado se guarda en Postgres con el rol copilot_checkpointer.
 */
export function createAgent(env: Env) {
  const db = createPrisma(env.DATABASE_URL_READ);
  const actionsDb = createPrisma(env.DATABASE_URL_ACTIONS);
  const tools = makeReadTools(db);
  const checkpointing = createCheckpointing(env.DATABASE_URL_CHECKPOINTS);

  const graph = buildGraph({
    models: {
      router: makeRouterModel(env),
      agent: claude(env, env.MODEL_AGENT).bindTools(tools),
      action: claude(env, env.MODEL_AGENT).bindTools([...tools, ...ACTION_DEFINITIONS]),
      chat: claude(env, env.MODEL_AGENT),
      clarify: makeClarifyModel(env),
    },
    tools,
    actions: makeActionRunner(db, actionsDb),
    checkpointer: checkpointing.saver,
  });
  return {
    graph,
    checkpointer: checkpointing.saver,
    pool: checkpointing.pool,
    close: async () => {
      await Promise.all([db.$disconnect(), actionsDb.$disconnect(), checkpointing.close()]);
    },
  };
}
