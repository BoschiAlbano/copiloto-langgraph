// Corre un caso del set de evaluación de la fase 11 con el agente real (R9): un hilo propio, los mensajes en orden, y
// las tarjetas se rechazan solas. Junta lo que se observó del último turno y lo pasa por las reglas.
import { deleteThread } from "../src/graph/threads.js";
import { streamResumeTurn, streamRunTurn, type TurnAgent, type TurnResult } from "../src/graph/run-turn.js";
import type { ModelUsage } from "../src/graph/usage-tracker.js";
import { clearMemories, listMemories, saveMemory, type MemoryBank } from "../src/memory/store.js";
import type { TraceSink } from "../src/observability/store.js";
import type { UiEvent } from "../src/web/events.js";
import { estimateCostUsd } from "../src/config/pricing.js";
import type { ConversationCase } from "./conversation-cases.js";
import { evaluateChecks, type CheckResult, type SqlRunner, type TurnObservation } from "./conversation-checks.js";

/** Lo que dice el rechazo automático de cada tarjeta (queda en el hilo, que después se borra). */
export const AUTO_REJECT = "Evaluación: se rechaza sola, no se escribe nada.";
/** Cuántas veces seguidas se rechaza una tarjeta antes de dar el turno por terminado (no debería pasar de una). */
const MAX_REJECTS = 3;

export interface CaseRun {
  caseId: string;
  category: string;
  runNo: number;
  passed: boolean;
  results: ({ check: string } & CheckResult)[];
  reply: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
  /** La traza del último turno (la que muestra por qué pasó o falló). */
  traceId?: string;
  /** Un error del sistema que no dejó terminar el caso. */
  error?: string;
}

export interface CaseDeps {
  /** El agente real: grafo con checkpointer y Store. */
  agent: TurnAgent & { checkpointer: Parameters<typeof deleteThread>[0] };
  /** Dónde dejar las trazas, ya marcadas con la corrida y el caso (o nada). */
  traces?: (caseId: string) => TraceSink;
  memory: MemoryBank;
  sql: SqlRunner;
  /** Para el id del hilo: `eval-<run>-<caso>-<n>`. */
  runTag: string;
}

async function collect(events: AsyncIterable<UiEvent>): Promise<{ events: UiEvent[]; result: TurnResult }> {
  const out: UiEvent[] = [];
  for await (const e of events) out.push(e);
  const last = out.at(-1);
  if (last?.type !== "done") throw new Error("el turno terminó sin resultado");
  return { events: out, result: last.result };
}

const addUsage = (total: { inputTokens: number; outputTokens: number; cost: number | null }, usage: ModelUsage[]) => {
  for (const u of usage) {
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    const cost = estimateCostUsd(u.model, u.inputTokens, u.outputTokens);
    total.cost = total.cost === null || cost === null ? null : total.cost + cost;
  }
};

/** Corre un caso y lo evalúa. Nunca lanza: un error del sistema es un caso que no pasó, con el motivo. */
export async function runCase(c: ConversationCase, runNo: number, deps: CaseDeps): Promise<CaseRun> {
  const threadId = `eval-${deps.runTag}-${c.id}-${runNo}`.toLowerCase();
  const agent: TurnAgent = { graph: deps.agent.graph, ...(deps.traces && { traces: deps.traces(c.id) }) };
  const started = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0, cost: 0 as number | null };
  let traceId: string | undefined;
  try {
    // Cada caso empieza con las memorias que pide, y nada más.
    await clearMemories(deps.memory);
    for (const m of c.memories ?? []) await saveMemory(deps.memory, m);
    const memoriesBefore = (await listMemories(deps.memory)).map((m) => m.text);

    let last: { events: UiEvent[]; results: TurnResult[] } = { events: [], results: [] };
    for (const text of c.turns) {
      const turn = await collect(streamRunTurn(agent, threadId, text));
      last = { events: [...turn.events], results: [turn.result] };
      addUsage(usage, turn.result.summary.usage);
      traceId = turn.result.traceId;
      // Las tarjetas se rechazan solas: el caso mira lo que se propuso, nunca escribe.
      let result = turn.result;
      for (let n = 0; result.awaiting && n < MAX_REJECTS; n++) {
        const resumed = await collect(streamResumeTurn(agent, threadId, { decision: "reject", comment: AUTO_REJECT }));
        last.events.push(...resumed.events);
        last.results.push(resumed.result);
        addUsage(usage, resumed.result.summary.usage);
        result = resumed.result;
      }
    }

    const first = last.results[0]!;
    const observation: TurnObservation = {
      reply: last.results.map((r) => r.reply).filter(Boolean).join("\n\n"),
      route: first.route.tasks?.map((t) => t.intent) ?? (first.route.intent ? [first.route.intent] : []),
      tools: last.events.flatMap((e) => (e.type === "tool_start" ? [{ name: e.name, args: e.args }] : [])),
      proposals: last.events.flatMap((e) => (e.type === "approval" ? [{ tool: e.request.action.tool, params: e.request.action.params }] : [])),
      ...(last.results.findLast((r) => r.report) && { report: last.results.findLast((r) => r.report)!.report }),
      memoriesBefore,
      memoriesAfter: (await listMemories(deps.memory)).map((m) => m.text),
    };
    const { passed, results } = await evaluateChecks(c.checks, observation, deps.sql);
    return base(c, runNo, { passed, results, reply: observation.reply }, usage, started, traceId);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return base(c, runNo, { passed: false, results: [], reply: "", error: message }, usage, started, traceId);
  } finally {
    // El hilo se borra; su traza queda (R9), para poder ver por qué falló.
    await deleteThread(deps.agent.checkpointer, threadId).catch(() => undefined);
    await clearMemories(deps.memory).catch(() => undefined);
  }
}

function base(
  c: ConversationCase,
  runNo: number,
  outcome: Pick<CaseRun, "passed" | "results" | "reply"> & { error?: string },
  usage: { inputTokens: number; outputTokens: number; cost: number | null },
  started: number,
  traceId: string | undefined,
): CaseRun {
  return {
    caseId: c.id,
    category: c.category,
    runNo,
    ...outcome,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.cost,
    durationMs: Date.now() - started,
    ...(traceId && { traceId }),
  };
}
