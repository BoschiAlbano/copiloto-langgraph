import { readFileSync } from "node:fs";
import { SystemMessage } from "@langchain/core/messages";
import { describeNow } from "../../tools/dates.js";
import type { AgentStateType } from "../state.js";
import type { AgentModel } from "./agent.js";

const actionPrompt = readFileSync(new URL("../prompts/action.md", import.meta.url), "utf8");

export const renderActionPrompt = (now: Date) => actionPrompt.replace("{{currentDateTime}}", describeNow(now));

/**
 * Agente de la rama de acciones. Su modelo tiene las herramientas de CONSULTA (que ejecuta `tools`) y las
 * definiciones de las cuatro acciones (que NO se ejecutan: el grafo las convierte en una propuesta que la
 * persona tiene que aprobar). Si pide una consulta va a `tools`; si pide una acción, a `propose_action`.
 */
export function makeActionAgentNode(model: AgentModel, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return async (state: AgentStateType) => {
    const reply = await model.invoke([new SystemMessage(renderActionPrompt(now())), ...state.messages]);
    return { messages: [reply] };
  };
}
