import { readFileSync } from "node:fs";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { routerOutputSchema } from "../intents.js";
import { buildRouterContext, formatTranscript } from "../router-context.js";
import type { AgentStateType } from "../state.js";

/**
 * Lo que el nodo necesita del modelo del router: algo que devuelva `{ parsed }`.
 * En producción es ChatAnthropic.withStructuredOutput(esquema, { includeRaw: true });
 * `parsed` llega en null si la salida del modelo no cumple el esquema.
 */
export interface RouterModel {
  invoke(messages: BaseMessage[]): Promise<{ parsed?: unknown } | null | undefined>;
}

const routerPrompt = readFileSync(new URL("../prompts/router.md", import.meta.url), "utf8");

export const ROUTER_FALLBACK_REASON = "Respaldo: la salida del router no cumplió el esquema.";

/**
 * El router clasifica el último mensaje y escribe `intent` en el estado. Una arista
 * condicional (routeByIntent) lee ese campo y elige el próximo nodo.
 *
 * Si la salida es inválida se usa `query`: es la rama de solo lectura, la menos riesgosa.
 * Un error real de la API (red, clave, cuota) NO se atrapa: sube hasta la terminal.
 */
export function makeRouterNode(
  model: RouterModel,
  options: { warn?: (message: string) => void } = {},
) {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  return async (state: AgentStateType) => {
    const transcript = formatTranscript(buildRouterContext(state.messages));
    const result = await model.invoke([
      new SystemMessage(routerPrompt),
      new HumanMessage(`Conversación reciente:\n${transcript}\n\nClasificá el último mensaje de la persona.`),
    ]);

    const output = routerOutputSchema.safeParse(result?.parsed);
    if (!output.success) {
      warn("[router] Salida inválida del modelo: se usa la ruta 'query' como respaldo.");
      return { intent: "query" as const, intentReason: ROUTER_FALLBACK_REASON };
    }
    return { intent: output.data.intent, intentReason: output.data.reason };
  };
}
