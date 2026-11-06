import type { StructuredToolInterface } from "@langchain/core/tools";
import type { Env } from "../config/env.js";
import { ACTIONS_STATEMENT_TIMEOUT_MS, createPrisma } from "../db/client.js";
import { ACTION_DEFINITIONS } from "../tools/actions/definitions.js";
import { makeReadTools } from "../tools/index.js";
import { makeActionRunner } from "./action-runner.js";
import { createMemoryStore, MEMORY_NAMESPACE } from "../memory/store.js";
import { createCheckpointing } from "./checkpointing.js";
import { buildGraph } from "./index.js";
import { PostgresTraceStore } from "../observability/store.js";
import { PostgresEvalStore } from "../observability/evals-store.js";
import { claude, makeClarifyModel, makeMemoryModel, makeReportModel, makeReportPlanModel, makeRouterModel } from "./models.js";
import { runSection } from "./report/sections.js";

export type Agent = ReturnType<typeof createAgent>;

/**
 * Arma el copiloto real, con un cliente de base de datos por rol:
 * - router y aclaración: modelo barato (MODEL_ROUTER); el router con salida estructurada;
 * - agente de consultas: MODEL_AGENT con herramientas de lectura (rol copilot_reader);
 * - agente de acciones: MODEL_AGENT con las mismas herramientas de lectura y las DEFINICIONES de las cuatro
 *   acciones. Las acciones se ejecutan solo tras una aprobación, con el rol copilot_actions;
 * - charla: MODEL_AGENT sin herramientas;
 * - reportes: MODEL_ROUTER elige el período, tres secciones leen la base a la vez (sin modelo) y MODEL_REPORT escribe la «Lectura»;
 * - hilos: el estado se guarda en Postgres con el rol copilot_checkpointer;
 * - memoria de largo plazo (fase 8): un Store de Postgres, mismo rol y esquema que los hilos. `memoryNamespace` es para los
 *   tests con el modelo real, que usan uno propio y no tocan las memorias del negocio.
 * - `wrapReadTools` (fase 10) es para los escenarios de fallas con el modelo real: envuelve las herramientas de
 *   lectura reales con una que falla a propósito (`failing` en tests/helpers). La app no lo usa.
 */
export function createAgent(
  env: Env,
  options: { memoryNamespace?: string[]; wrapReadTools?: (tools: StructuredToolInterface[]) => StructuredToolInterface[] } = {},
) {
  const db = createPrisma(env.DATABASE_URL_READ);
  const actionsDb = createPrisma(env.DATABASE_URL_ACTIONS, { statementTimeoutMs: ACTIONS_STATEMENT_TIMEOUT_MS });
  const readTools: StructuredToolInterface[] = makeReadTools(db);
  const tools = options.wrapReadTools ? options.wrapReadTools(readTools) : readTools;
  const checkpointing = createCheckpointing(env.DATABASE_URL_CHECKPOINTS);
  // Las trazas de cada turno (fase 11): mismo rol y mismo pool que los hilos. Las viejas se borran al arrancar.
  const traces = new PostgresTraceStore(checkpointing.pool);
  traces.prune(env.TRACE_RETENTION_DAYS).catch((error) => console.warn(`[trazas] No se pudieron borrar las viejas: ${(error as Error).message}`));
  // La memoria de largo plazo (fase 8): el Store, en el mismo esquema y con el mismo rol que los hilos.
  const store = createMemoryStore(env.DATABASE_URL_CHECKPOINTS);

  const graph = buildGraph({
    models: {
      router: makeRouterModel(env),
      agent: claude(env, env.MODEL_AGENT).bindTools(tools),
      action: claude(env, env.MODEL_AGENT).bindTools([...tools, ...ACTION_DEFINITIONS]),
      chat: claude(env, env.MODEL_AGENT),
      clarify: makeClarifyModel(env),
      reportPlan: makeReportPlanModel(env),
      report: makeReportModel(env),
      memory: makeMemoryModel(env),
    },
    tools,
    actions: makeActionRunner(db, actionsDb),
    // Las secciones de un reporte solo LEEN: usan el mismo cliente de solo lectura que las herramientas.
    reportSections: (section, reportId, range) => runSection(section, reportId, range, db),
    // Para no guardar memorias sobre clientes: sus nombres, con el rol de lectura.
    clientNames: async () => (await db.client.findMany({ select: { name: true } })).map((c) => c.name),
    checkpointer: checkpointing.saver,
    store,
    memoryNamespace: options.memoryNamespace,
  });
  return {
    graph,
    checkpointer: checkpointing.saver,
    pool: checkpointing.pool,
    /** Las trazas de los turnos (fase 11). */
    traces,
    /** Las corridas del set de evaluación (fase 11). */
    evals: new PostgresEvalStore(checkpointing.pool),
    /** Los límites de operación de cada turno (fase 12). */
    limits: { turnTimeoutMs: env.TURN_TIMEOUT_MS },
    /** La memoria de largo plazo y su namespace (para listar y borrar desde la terminal). */
    memory: { store, namespace: options.memoryNamespace ?? MEMORY_NAMESPACE },
    close: async () => {
      await Promise.all([db.$disconnect(), actionsDb.$disconnect(), checkpointing.close(), store.stop()]);
    },
  };
}
