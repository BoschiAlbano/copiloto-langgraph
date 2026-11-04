import { readPrompt } from "../prompts/read.js";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { normalizePlan, PLAN_FALLBACK_REASON, type TaskState } from "../plan.js";
import { buildRouterContext, formatTranscript } from "../router-context.js";

/**
 * Lo que el nodo necesita del modelo del router: algo que devuelva `{ parsed }`.
 * En producción es ChatAnthropic.withStructuredOutput(esquema, { includeRaw: true });
 * `parsed` llega en null si la salida del modelo no cumple el esquema.
 */
export interface RouterModel {
  invoke(messages: BaseMessage[]): Promise<{ parsed?: unknown } | null | undefined>;
}

const routerPrompt = readPrompt(new URL("../prompts/router.md", import.meta.url));

export const ROUTER_FALLBACK_REASON = PLAN_FALLBACK_REASON;

/**
 * El router parte el último mensaje en tareas y escribe el plan en el estado (fase 7), ya normalizado por el código
 * (`normalizePlan`). El supervisor recorre ese plan. `intent` es la intención de la primera tarea.
 *
 * Si la salida es inválida se usa una sola tarea `query`: es la rama de solo lectura, la menos riesgosa.
 * Un error real de la API (red, clave, cuota) NO se atrapa: sube hasta la terminal.
 */
export function makeRouterNode(
  model: RouterModel,
  options: { warn?: (message: string) => void } = {},
) {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  return async (state: Pick<TaskState, "messages">) => {
    const transcript = formatTranscript(buildRouterContext(state.messages));
    const result = await model.invoke([
      new SystemMessage(routerPrompt),
      new HumanMessage(`Conversación reciente:\n${transcript}\n\nClasificá el último mensaje de la persona.`),
    ]);

    const last = state.messages.findLast((m) => HumanMessage.isInstance(m))?.text ?? "";
    const { plan, intent, reason, fallback } = normalizePlan(result?.parsed, last);
    if (fallback) warn("[router] Salida inválida del modelo: se usa la ruta 'query' como respaldo.");
    return { intent, intentReason: reason, plan };
  };
}
