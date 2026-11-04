import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph";
import { buildGraph } from "../../src/graph/index.js";
import type { Intent } from "../../src/graph/intents.js";
import type { AgentModel } from "../../src/graph/nodes/agent.js";
import type { ActionRunner } from "../../src/graph/nodes/actions.js";
import type { SectionRunner } from "../../src/graph/nodes/report.js";
import type { RouterModel } from "../../src/graph/nodes/router.js";

/** Salida del router (formato de la fase 7) para un pedido de una sola tarea. */
export const routed = (intent: Intent, reason = "decisión de prueba") => ({ reason, tasks: [{ intent, request: "pedido de prueba" }] });

/** Salida del router para un pedido de varias partes: `[intención, pedido]` por tarea. */
export const planned = (...tasks: [Intent, string][]) => ({
  reason: "pedido de varias partes",
  tasks: tasks.map(([intent, request]) => ({ intent, request })),
});

/**
 * Router falso que siempre decide lo mismo (o una secuencia, una decisión por llamada). Cada decisión es una
 * intención (un pedido de una sola tarea) o una salida completa armada con `planned`.
 */
export function fixedRouter(intents: Intent | (Intent | ReturnType<typeof planned>)[] | ReturnType<typeof planned> = "query") {
  const calls: unknown[][] = [];
  const queue = Array.isArray(intents) ? [...intents] : [intents];
  const model: RouterModel = {
    async invoke(messages) {
      calls.push(messages);
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return { parsed: typeof next === "string" ? routed(next) : next };
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

/** Planificador de reportes que falla si un test que no lo espera llega a usarlo. */
export const unexpectedPlan: RouterModel = {
  async invoke() {
    throw new Error("Este test no esperaba planificar un reporte.");
  },
};

/** Secciones de reporte que fallan si un test que no las espera llega a usarlas. */
export const unexpectedSections: SectionRunner = async () => {
  throw new Error("Este test no esperaba correr una sección de reporte.");
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
  reportPlan = unexpectedPlan,
  reportSections = unexpectedSections,
  intent = "query",
  router,
  now,
  checkpointer,
  store,
  memoryNamespace,
  memoryModel,
}: {
  model: AgentModel;
  actionModel?: AgentModel;
  tools: StructuredToolInterface[];
  actions?: ActionRunner;
  reportPlan?: RouterModel;
  reportSections?: SectionRunner;
  intent?: Parameters<typeof fixedRouter>[0];
  /** Un router propio, en lugar del fijo que arma `intent`. */
  router?: RouterModel;
  now?: () => Date;
  checkpointer?: BaseCheckpointSaver;
  /** Memoria de largo plazo (fase 8). Sin Store, no hay memorias. */
  store?: BaseStore;
  memoryNamespace?: string[];
  /** El modelo del nodo de memoria (fase 8). Sin él, la memoria no está disponible. */
  memoryModel?: RouterModel;
}) {
  return buildGraph({
    models: {
      router: router ?? fixedRouter(intent).model,
      agent: model,
      action: actionModel ?? model,
      chat: model,
      clarify: model,
      reportPlan,
      report: model,
      memory: memoryModel,
    },
    tools,
    actions,
    reportSections,
    now,
    checkpointer,
    store,
    memoryNamespace,
  });
}
