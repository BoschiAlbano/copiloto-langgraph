import type { StructuredToolInterface } from "@langchain/core/tools";
import { END, START, StateGraph, type BaseCheckpointSaver, type BaseStore } from "@langchain/langgraph";
import { buildActionGraph } from "../agents/action.js";
import { buildQueryGraph } from "../agents/query.js";
import { buildReportGraph } from "../agents/report.js";
import type { ActionRunner } from "./nodes/actions.js";
import type { AgentModel } from "./nodes/agent.js";
import { makeChatNode } from "./nodes/chat.js";
import { makeClarifyNode } from "./nodes/clarify.js";
import { makeLoadMemoryNode } from "./nodes/load-memory.js";
import { makeMemoryNode, type MemoryModel } from "./nodes/memory.js";
import type { PlanModel, SectionRunner } from "./nodes/report.js";
import { makeRouterNode, type RouterModel } from "./nodes/router.js";
import { supervise } from "./nodes/supervisor.js";
import { AGENT_NODE_NAMES } from "./plan.js";
import { AgentState } from "./state.js";
import { isTransient } from "../tools/retry.js";

/** Reintentos de `load_memory` (fase 10): 3 intentos, ~200 y ~600 ms, solo ante fallas transitorias de la base. */
export const LOAD_MEMORY_RETRY = { maxAttempts: 3, initialInterval: 200, backoffFactor: 3, maxInterval: 1000, retryOn: isTransient };

export interface BuildGraphOptions {
  models: {
    /** Parte el pedido en tareas (salida estructurada). */
    router: RouterModel;
    /** Con las herramientas de consulta ya enlazadas (bindTools). */
    agent: AgentModel;
    /** Con las herramientas de consulta y las DEFINICIONES de las acciones enlazadas (no se ejecutan como herramientas). */
    action: AgentModel;
    /** SIN herramientas. */
    chat: AgentModel;
    /** SIN herramientas: escribe la pregunta de aclaración. */
    clarify: AgentModel;
    /** Modelo barato con salida estructurada: decide el período de un reporte. */
    reportPlan: PlanModel;
    /** SIN herramientas: escribe la «Lectura» de un reporte a partir de datos ya calculados. */
    report: AgentModel;
    /** Modelo barato con salida estructurada: decide qué hacer con la memoria (fase 8). Sin él, la memoria no está disponible. */
    memory?: MemoryModel;
  };
  /** Las herramientas de CONSULTA, para los ToolNode de los agentes de consultas y de acciones. Nunca incluye acciones. */
  tools: StructuredToolInterface[];
  /** Prepara y ejecuta las acciones aprobadas. */
  actions: ActionRunner;
  /** Corre una sección de un reporte (ventas, turnos o stock). Las tres corren a la vez. */
  reportSections: SectionRunner;
  /** Reloj inyectable para los tests. */
  now?: () => Date;
  /** Avisos de quien opera el sistema (por ejemplo, salida inválida del router). */
  warn?: (message: string) => void;
  /** Guarda el estado después de cada paso, por thread_id, también el de los subgrafos. Las acciones lo necesitan. */
  checkpointer?: BaseCheckpointSaver;
  /** Memoria de largo plazo (fase 8), compartida por todos los hilos. Sin Store, no hay memorias. */
  store?: BaseStore;
  /** Namespace de las memorias en el Store (los tests usan uno propio). */
  memoryNamespace?: string[];
  /** Nombres completos de los clientes: no se guardan memorias sobre clientes (fase 8). */
  clientNames?: () => Promise<string[]>;
}

/**
 * Grafo principal (fases 7 y 8): un supervisor reparte el plan del router entre agentes especializados, y cada turno
 * empieza cargando la memoria de largo plazo.
 *
 *  START → load_memory → router → supervisor ─┬─ query_graph  ─┐   (subgrafo: agent ⇄ tools)
 *          (Store →        (plan)    ▲        ├─ action_graph ─┤   (subgrafo: aprobación con interrupt)
 *       businessContext)             │        ├─ report_graph ─┤   (subgrafo: tres secciones en paralelo)
 *                                    │        ├─ memory       ─┤   (guardar, listar y borrar en el Store)
 *                                    │        ├─ chat         ─┤
 *                                    │        ├─ clarify      ─┤
 *                                    │        └─ END           │
 *                                    └─────────────────────────┘   cada agente vuelve al supervisor por una arista fija
 *
 * Los tres subgrafos se agregan como nodos: comparten con este grafo los campos del mismo nombre (`messages`, `plan`,
 * `businessContext` y, el de reportes, `report`) y guardan sus pasos con el mismo checkpointer, en su propio espacio de
 * nombres. El Store no depende del hilo: lo que `memory` anota en uno, `load_memory` lo lee en todos.
 */
export function buildGraph({ models, tools, actions, reportSections, now, warn, checkpointer, store, memoryNamespace, clientNames }: BuildGraphOptions) {
  return (
    new StateGraph(AgentState)
      // Fase 8: cada turno empieza leyendo las memorias del negocio del Store.
      // Fase 10: leer la memoria es una lectura de la base que lanza su error: la reintenta LangGraph (retryPolicy).
      .addNode("load_memory", makeLoadMemoryNode({ namespace: memoryNamespace }), { retryPolicy: LOAD_MEMORY_RETRY })
      .addNode("router", makeRouterNode(models.router, { warn }))
      // Devuelve un Command (actualización + destino): los destinos posibles se declaran en `ends`.
      .addNode("supervisor", supervise, { ends: [...AGENT_NODE_NAMES, END] })
      .addNode("query_graph", buildQueryGraph({ model: models.agent, tools, now }))
      .addNode("action_graph", buildActionGraph({ model: models.action, tools, actions, now }))
      .addNode("report_graph", buildReportGraph({ plan: models.reportPlan, reading: models.report, sections: reportSections, now, warn }))
      .addNode("chat", makeChatNode(models.chat))
      .addNode("clarify", makeClarifyNode(models.clarify))
      .addNode("memory", makeMemoryNode(models.memory, { namespace: memoryNamespace, clientNames, now, warn }))
      .addEdge(START, "load_memory")
      .addEdge("load_memory", "router")
      .addEdge("router", "supervisor")
      .addEdge("query_graph", "supervisor")
      .addEdge("action_graph", "supervisor")
      .addEdge("report_graph", "supervisor")
      .addEdge("chat", "supervisor")
      .addEdge("clarify", "supervisor")
      .addEdge("memory", "supervisor")
      // El Store se da al compilar, como el checkpointer: LangGraph se lo pasa a cada nodo en `config.store`.
      .compile({ checkpointer, store })
  );
}
