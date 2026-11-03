import { readFileSync } from "node:fs";
import { describeNow } from "../../tools/dates.js";
import { agentInput, type TaskState } from "../plan.js";
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
  return async (state: TaskState) => {
    const reply = await model.invoke(agentInput(renderActionPrompt(now()), state));
    return { messages: [reply] };
  };
}
