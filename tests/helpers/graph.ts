import type { StructuredToolInterface } from "@langchain/core/tools";
import { buildGraph } from "../../src/graph/index.js";
import type { Intent } from "../../src/graph/intents.js";
import type { AgentModel } from "../../src/graph/nodes/agent.js";
import type { RouterModel } from "../../src/graph/nodes/router.js";

/** Router falso que siempre decide lo mismo (o una secuencia, una intención por llamada). */
export function fixedRouter(intents: Intent | Intent[] = "query") {
  const calls: unknown[][] = [];
  const queue = Array.isArray(intents) ? [...intents] : null;
  const model: RouterModel = {
    async invoke(messages) {
      calls.push(messages);
      const intent = queue ? (queue.length > 1 ? queue.shift()! : queue[0]!) : (intents as Intent);
      return { parsed: { reason: "decisión de prueba", intent } };
    },
  };
  return { model, calls };
}

/**
 * Grafo completo para tests: el router siempre elige `intent` y todas las ramas con modelo
 * usan `model`. Los tests del camino de consulta (fases 1 y 2) solo cambian en esta construcción.
 */
export function buildTestGraph({
  model,
  tools,
  intent = "query",
  now,
}: {
  model: AgentModel;
  tools: StructuredToolInterface[];
  intent?: Intent | Intent[];
  now?: () => Date;
}) {
  return buildGraph({
    models: { router: fixedRouter(intent).model, agent: model, chat: model, clarify: model },
    tools,
    now,
  });
}
