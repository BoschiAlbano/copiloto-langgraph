import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { estimateCostUsd } from "../config/pricing.js";

export interface ModelUsage {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** El uso de una corrida de un nodo del grafo principal (un agente o el router), en el orden en que empezó. */
export interface RunUsage {
  /** El nodo del grafo principal: `router`, `query_graph`, `action_graph`, `report_graph`, `chat` o `clarify`. */
  node: string;
  usage: ModelUsage[];
}

const UNKNOWN_RUN = "desconocido";

/**
 * A qué corrida del grafo principal pertenece una llamada al modelo (fase 7). LangGraph le pasa a cada llamada, en
 * sus metadatos, el espacio de nombres del nodo que la hizo: `router:<id>` para un nodo del principal, o
 * `query_graph:<id>|agent:<id>` para uno de adentro de un subgrafo. El primer tramo identifica la corrida.
 */
export function runKeyOf(metadata?: Record<string, unknown>): string {
  const ns = metadata?.langgraph_checkpoint_ns;
  return typeof ns === "string" && ns ? ns.split("|")[0]! : UNKNOWN_RUN;
}

const add = (map: Map<string, ModelUsage>, model: string, input: number, output: number) => {
  const entry = map.get(model) ?? { model, calls: 0, inputTokens: 0, outputTokens: 0 };
  entry.calls += 1;
  entry.inputTokens += input;
  entry.outputTokens += output;
  map.set(model, entry);
};

/**
 * Callback de LangChain que suma los tokens de CADA llamada al modelo, agrupados por modelo y, desde la fase 7, por
 * corrida (qué agente hizo la llamada).
 *
 * Hace falta porque la salida estructurada del router no deja su uso en `messages`: el único
 * lugar donde se ve el consumo de todos los nodos (router, aclaración, charla, agente) es el
 * evento de fin de cada llamada. Se pasa en la configuración de `graph.invoke`.
 */
export class UsageTracker extends BaseCallbackHandler {
  name = "usage_tracker";
  // Esperar a que el handler termine antes de que `invoke` devuelva: si no, los totales
  // podrían leerse antes de registrar la última llamada.
  awaitHandlers = true;

  private readonly byModel = new Map<string, ModelUsage>();
  /** Por corrida, en el orden en que empezaron (un Map conserva el orden de inserción). */
  private readonly byRun = new Map<string, Map<string, ModelUsage>>();
  /** Qué corrida hizo cada llamada en curso: los metadatos llegan al empezar, los tokens al terminar. */
  private readonly runOfCall = new Map<string, string>();
  /**
   * El modelo de cada llamada en curso, según lo que se pidió al empezar. Con streaming (fase 9), la respuesta de
   * Claude llega en fragmentos y la suma no siempre trae el nombre del modelo: este es el respaldo.
   */
  private readonly modelOfCall = new Map<string, string>();

  handleChatModelStart(_llm: unknown, _messages: unknown, runId: string, _parentRunId?: string, extra?: Record<string, unknown>, _tags?: string[], metadata?: Record<string, unknown>) {
    const requested = metadata?.ls_model_name ?? (extra?.invocation_params as { model?: unknown } | undefined)?.model;
    if (typeof requested === "string" && requested) this.modelOfCall.set(runId, requested);
    const key = runKeyOf(metadata);
    this.runOfCall.set(runId, key);
    if (!this.byRun.has(key)) this.byRun.set(key, new Map());
  }

  handleLLMEnd(output: LLMResult, runId?: string) {
    const message = (output.generations?.[0]?.[0] as { message?: BaseMessage } | undefined)?.message;
    const ai = message && AIMessage.isInstance(message) ? message : undefined;
    const requested = runId ? this.modelOfCall.get(runId) : undefined;
    if (runId) this.modelOfCall.delete(runId);
    const model = String(ai?.response_metadata?.model ?? ai?.response_metadata?.model_name ?? output.llmOutput?.model ?? requested ?? "desconocido");
    const input = ai?.usage_metadata?.input_tokens ?? 0;
    const outputTokens = ai?.usage_metadata?.output_tokens ?? 0;

    add(this.byModel, model, input, outputTokens);
    const key = (runId && this.runOfCall.get(runId)) || UNKNOWN_RUN;
    if (runId) this.runOfCall.delete(runId);
    if (!this.byRun.has(key)) this.byRun.set(key, new Map());
    add(this.byRun.get(key)!, model, input, outputTokens);
  }

  /** Uso acumulado, un renglón por modelo. */
  usage(): ModelUsage[] {
    return [...this.byModel.values()].map((u) => ({ ...u }));
  }

  /** Uso por corrida, en el orden en que empezaron; solo las que llamaron al modelo. */
  runs(): RunUsage[] {
    return [...this.byRun.entries()]
      .filter(([, models]) => models.size > 0)
      .map(([key, models]) => ({ node: key.split(":")[0]!, usage: [...models.values()].map((u) => ({ ...u })) }));
  }
}

export function totalUsage(usage: ModelUsage[]) {
  return usage.reduce(
    (sum, u) => ({
      calls: sum.calls + u.calls,
      inputTokens: sum.inputTokens + u.inputTokens,
      outputTokens: sum.outputTokens + u.outputTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0 },
  );
}

/** Costo estimado en USD de todos los renglones, o null si algún modelo no tiene precio conocido. */
export function costOfUsage(usage: ModelUsage[]): number | null {
  let total = 0;
  for (const u of usage) {
    const cost = estimateCostUsd(u.model, u.inputTokens, u.outputTokens);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

/** Junta varios resúmenes de uso (por ejemplo, los turnos de una sesión) en uno por modelo. */
export function mergeUsage(...lists: ModelUsage[][]): ModelUsage[] {
  const merged = new Map<string, ModelUsage>();
  for (const u of lists.flat()) {
    const entry = merged.get(u.model) ?? { model: u.model, calls: 0, inputTokens: 0, outputTokens: 0 };
    entry.calls += u.calls;
    entry.inputTokens += u.inputTokens;
    entry.outputTokens += u.outputTokens;
    merged.set(u.model, entry);
  }
  return [...merged.values()];
}
