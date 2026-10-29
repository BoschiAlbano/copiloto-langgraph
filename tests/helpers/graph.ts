import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { buildGraph } from "../../src/graph/index.js";
import type { Intent } from "../../src/graph/intents.js";
import type { AgentModel } from "../../src/graph/nodes/agent.js";
import type { ActionRunner } from "../../src/graph/nodes/actions.js";
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

/** Ejecutor de acciones que falla si algún test que no lo espera llega a usarlo. */
export const unexpectedActions: ActionRunner = {
  async prepare() {
    throw new Error("Este test no esperaba preparar una acción.");
  },
  async execute() {
    throw new Error("Este test no esperaba ejecutar una acción.");
  },
};

/**
 * Grafo completo para tests: el router siempre elige `intent` y todas las ramas con modelo
 * usan `model` (la de acciones puede tener el suyo con `actionModel`). Los tests del camino de
 * consulta (fases 1 y 2) solo cambian en esta construcción.
 */
export function buildTestGraph({
  model,
  actionModel,
  tools,
  actions = unexpectedActions,
  intent = "query",
  now,
  checkpointer,
}: {
  model: AgentModel;
  actionModel?: AgentModel;
  tools: StructuredToolInterface[];
  actions?: ActionRunner;
  intent?: Intent | Intent[];
  now?: () => Date;
  checkpointer?: BaseCheckpointSaver;
}) {
  return buildGraph({
    models: { router: fixedRouter(intent).model, agent: model, action: actionModel ?? model, chat: model, clarify: model },
    tools,
    actions,
    now,
    checkpointer,
  });
}
