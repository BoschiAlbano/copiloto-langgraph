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

/**
 * Callback de LangChain que suma los tokens de CADA llamada al modelo, agrupados por modelo.
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

  handleLLMEnd(output: LLMResult) {
    const message = (output.generations?.[0]?.[0] as { message?: BaseMessage } | undefined)?.message;
    const ai = message && AIMessage.isInstance(message) ? message : undefined;
    const model = String(ai?.response_metadata?.model ?? ai?.response_metadata?.model_name ?? output.llmOutput?.model ?? "desconocido");

    const entry = this.byModel.get(model) ?? { model, calls: 0, inputTokens: 0, outputTokens: 0 };
    entry.calls += 1;
    entry.inputTokens += ai?.usage_metadata?.input_tokens ?? 0;
    entry.outputTokens += ai?.usage_metadata?.output_tokens ?? 0;
    this.byModel.set(model, entry);
  }

  /** Uso acumulado, un renglón por modelo. */
  usage(): ModelUsage[] {
    return [...this.byModel.values()].map((u) => ({ ...u }));
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
