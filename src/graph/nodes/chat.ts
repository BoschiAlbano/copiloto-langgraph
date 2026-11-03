import { readFileSync } from "node:fs";
import { SystemMessage } from "@langchain/core/messages";
import type { TaskState } from "../plan.js";
import type { AgentModel } from "./agent.js";

const chatPrompt = readFileSync(new URL("../prompts/chat.md", import.meta.url), "utf8");

/**
 * Rama de charla: Claude SIN herramientas enlazadas. No hay nada que llamar, así que
 * un saludo o un "gracias" no puede terminar tocando la base. Es el nodo que tenía el
 * grafo de la fase 1, con otro prompt.
 */
export function makeChatNode(model: AgentModel) {
  return async (state: Pick<TaskState, "messages">) => {
    const reply = await model.invoke([new SystemMessage(chatPrompt), ...state.messages]);
    return { messages: [reply] };
  };
}
