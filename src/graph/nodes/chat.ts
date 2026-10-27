import { readFileSync } from "node:fs";
import type { BaseMessage } from "@langchain/core/messages";
import { SystemMessage } from "@langchain/core/messages";
import type { AgentStateType } from "../state.js";

/** Lo mínimo que el nodo necesita del modelo: así los tests pasan uno falso. */
export interface ChatModel {
  invoke(messages: BaseMessage[]): Promise<BaseMessage>;
}

const systemPrompt = readFileSync(new URL("../prompts/system.md", import.meta.url), "utf8");

/**
 * Un nodo es una función (estado) => actualización parcial del estado.
 * Acá devolvemos solo el mensaje nuevo; el reducer lo agrega al historial.
 */
export function makeChatNode(model: ChatModel) {
  return async (state: AgentStateType) => {
    const reply = await model.invoke([new SystemMessage(systemPrompt), ...state.messages]);
    return { messages: [reply] };
  };
}
