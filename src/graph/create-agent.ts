import { ChatAnthropic } from "@langchain/anthropic";
import type { Env } from "../config/env.js";
import { createPrisma } from "../db/client.js";
import { makeReadTools } from "../tools/index.js";
import { buildGraph } from "./index.js";

/**
 * Tope de pasos del grafo por conversación-turno (cada paso es un nodo ejecutado).
 * Un turno normal con herramientas usa 3: agent → tools → agent. La política completa
 * de reintentos y topes llega en la fase 10.
 */
export const AGENT_RECURSION_LIMIT = 10;

export type Agent = ReturnType<typeof createAgent>;

/** Arma el agente real: Claude + herramientas de lectura sobre la base con el rol copilot_reader. */
export function createAgent(env: Env) {
  const db = createPrisma(env.DATABASE_URL_READ);
  const tools = makeReadTools(db);
  const model = new ChatAnthropic({ model: env.MODEL_AGENT, apiKey: env.ANTHROPIC_API_KEY }).bindTools(tools);
  return { graph: buildGraph({ model, tools }), close: () => db.$disconnect() };
}
