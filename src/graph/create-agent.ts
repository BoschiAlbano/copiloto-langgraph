import { ChatAnthropic } from "@langchain/anthropic";
import type { Env } from "../config/env.js";
import { createPrisma } from "../db/client.js";
import { makeReadTools } from "../tools/index.js";
import { buildGraph } from "./index.js";
import { routerOutputSchema } from "./intents.js";

export type Agent = ReturnType<typeof createAgent>;

/**
 * Arma el copiloto real:
 * - router y aclaración: modelo barato (MODEL_ROUTER); el router con salida estructurada, temperatura 0;
 * - agente: MODEL_AGENT con herramientas de lectura sobre la base con el rol copilot_reader;
 * - charla: MODEL_AGENT sin herramientas.
 */
export function createAgent(env: Env) {
  const db = createPrisma(env.DATABASE_URL_READ);
  const tools = makeReadTools(db);
  const claude = (model: string, temperature?: number) =>
    new ChatAnthropic({ model, apiKey: env.ANTHROPIC_API_KEY, ...(temperature !== undefined && { temperature }) });

  const graph = buildGraph({
    models: {
      router: claude(env.MODEL_ROUTER, 0).withStructuredOutput(routerOutputSchema, { name: "route", includeRaw: true }),
      agent: claude(env.MODEL_AGENT).bindTools(tools),
      chat: claude(env.MODEL_AGENT),
      clarify: claude(env.MODEL_ROUTER, 0),
    },
    tools,
  });
  return { graph, close: () => db.$disconnect() };
}
