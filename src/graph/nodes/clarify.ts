import { readFileSync } from "node:fs";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildRouterContext, formatTranscript } from "../router-context.js";
import type { AgentStateType } from "../state.js";
import type { AgentModel } from "./agent.js";

const clarifyPrompt = readFileSync(new URL("../prompts/clarify.md", import.meta.url), "utf8");

/**
 * Rama para pedidos que no se entienden: una llamada corta a un modelo sin herramientas que
 * escribe la pregunta. Ve la misma transcripción acotada que el router.
 */
export function makeClarifyNode(model: AgentModel) {
  return async (state: AgentStateType) => {
    const transcript = formatTranscript(buildRouterContext(state.messages));
    const reply = await model.invoke([
      new SystemMessage(clarifyPrompt),
      new HumanMessage(`Conversación reciente:\n${transcript}\n\nEscribí la pregunta de aclaración.`),
    ]);
    return { messages: [reply] };
  };
}
