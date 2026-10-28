import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { AgentModel } from "../../src/graph/nodes/agent.js";

/** Modelo falso guionado: devuelve una respuesta por llamada y guarda lo que recibió. */
export function scriptedModel(script: AIMessage[] | ((callNumber: number, messages: BaseMessage[]) => AIMessage)) {
  const calls: BaseMessage[][] = [];
  const model: AgentModel = {
    async invoke(messages) {
      const n = calls.length;
      calls.push(messages);
      const reply = typeof script === "function" ? script(n, messages) : script[n];
      if (!reply) throw new Error(`El guion no tiene respuesta para la llamada ${n + 1}`);
      return reply;
    },
  };
  return { model, calls };
}

/** Responde "eco: <último mensaje de la persona>" y guarda lo que recibió. */
export function echoModel() {
  return scriptedModel((_n, messages) => {
    const lastHuman = messages.findLast((m) => m.type === "human");
    return new AIMessage(`eco: ${lastHuman?.text ?? ""}`);
  });
}

export const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) =>
  new AIMessage({ content: "", tool_calls: [{ id, name, args, type: "tool_call" }] });
