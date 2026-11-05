import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { Plan } from "../plan.js";
import { TOOL_LABELS } from "../../web/turn-view.js";

// El tope de iteraciones de los agentes con herramientas (fase 10, R5 y R6). Un agente que da vueltas (pide
// herramientas sin llegar a una respuesta, o repite exactamente la misma consulta) no sigue hasta el límite de
// recursión: pasa a `recover`, que cierra la tarea con un mensaje armado por el código.

/** Rondas de herramientas por tarea: con 4 alcanza para lo que se vio en las fases 2 a 9 (2 como mucho, en general). */
export const MAX_TOOL_ROUNDS = 4;

interface LoopState {
  messages: BaseMessage[];
  plan?: Plan;
}

type ToolCall = NonNullable<AIMessage["tool_calls"]>[number];

/** Una llamada como texto comparable: el nombre y los argumentos con las claves ordenadas. */
function callKey(call: Pick<ToolCall, "name" | "args">): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]))
        : value;
  return `${call.name}:${JSON.stringify(sorted(call.args ?? {}))}`;
}

/** Los mensajes de la tarea en curso: desde que el supervisor se la pasó a este agente (`startedAt`, fase 7). */
function taskMessages(state: LoopState): BaseMessage[] {
  const running = state.plan?.tasks.find((t) => t.status === "running");
  return state.messages.slice(running?.startedAt ?? 0);
}

/** Los pedidos de herramientas de la tarea, en orden (cada mensaje de IA con `tool_calls` es una ronda). */
function toolRounds(state: LoopState): ToolCall[][] {
  return taskMessages(state)
    .filter((m): m is AIMessage => AIMessage.isInstance(m) && Boolean(m.tool_calls?.length))
    .map((m) => m.tool_calls ?? []);
}

export type LoopReason = { kind: "rounds"; rounds: number } | { kind: "repeat"; call: string };

/**
 * ¿El último pedido del agente es un loop? Sí, si pasa el tope de rondas o si repite una llamada que ya hizo en esta
 * tarea (mismo nombre y mismos argumentos). Se mira ANTES de ejecutar las herramientas pedidas.
 */
export function detectLoop(state: LoopState, maxRounds = MAX_TOOL_ROUNDS): LoopReason | undefined {
  const rounds = toolRounds(state);
  const last = rounds.at(-1);
  if (!last) return undefined;
  if (rounds.length > maxRounds) return { kind: "rounds", rounds: rounds.length - 1 };
  const before = new Set(rounds.slice(0, -1).flat().map(callKey));
  const repeated = last.find((call) => before.has(callKey(call)));
  if (repeated) return { kind: "repeat", call: repeated.name };
  return undefined;
}

const label = (name: string) => (TOOL_LABELS[name] ?? name).toLowerCase();

/** El texto de cierre (lo arma el código, no el modelo: nada inventado). */
export function recoverMessage(reason: LoopReason, consulted: string[], kind: "query" | "action"): string {
  const what = kind === "action" ? "preparar la acción" : "terminar la consulta";
  const used = [...new Set(consulted)].map(label);
  const list = used.length ? ` Llegué a consultar: ${used.join(", ")}.` : "";
  const why =
    reason.kind === "rounds"
      ? `No pude ${what}: hice ${reason.rounds} rondas de consultas sin llegar a una respuesta.`
      : `No pude ${what}: estaba repitiendo la misma consulta (${label(reason.call)}) sin avanzar.`;
  return `${why}${list} No te doy un dato que no pude confirmar. Probá pedirlo de forma más concreta (por ejemplo, con una fecha, un nombre o un producto).`;
}

/**
 * `recover` (fase 10, R6): cierra la tarea sin otro llamado al modelo. Responde a las llamadas que quedaron pedidas (la
 * API de Claude no acepta un pedido de herramienta sin su respuesta en el historial) y agrega el mensaje de cierre.
 * El turno termina normalmente: no queda a medias, así que «Continuar» no repite el loop.
 */
export function makeRecoverNode(kind: "query" | "action", options: { maxRounds?: number; warn?: (message: string) => void } = {}) {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  return async (state: LoopState) => {
    const reason = detectLoop(state, options.maxRounds) ?? { kind: "rounds" as const, rounds: options.maxRounds ?? MAX_TOOL_ROUNDS };
    const rounds = toolRounds(state);
    const pending = rounds.at(-1) ?? [];
    const consulted = rounds.slice(0, -1).flat().map((c) => c.name);
    warn(`[recover] ${kind === "action" ? "acciones" : "consultas"}: ${reason.kind === "rounds" ? `tope de ${reason.rounds} rondas` : `llamada repetida (${reason.call})`}`);
    const skipped = pending.map(
      (call) =>
        new ToolMessage({
          tool_call_id: call.id ?? "",
          name: call.name,
          status: "error",
          content: "No se ejecutó: se alcanzó el tope de consultas de esta tarea.",
          // No es una falla de la base: la web y el resumen la muestran como «no se ejecutó».
          additional_kwargs: { skipped: true },
        }),
    );
    return { messages: [...skipped, new AIMessage(recoverMessage(reason, consulted, kind))] };
  };
}
