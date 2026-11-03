import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
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

/**
 * Modelo falso que SÍ es un modelo de chat de LangChain: dispara los callbacks (con los metadatos de LangGraph, como
 * el espacio de nombres del nodo) y devuelve tokens y nombre de modelo. Sirve para probar el uso por agente sin API.
 */
export class TrackedChatModel extends BaseChatModel {
  calls = 0;

  constructor(
    private readonly script: AIMessage[],
    private readonly modelName = "claude-haiku-5-5",
    private readonly tokens = { input: 100, output: 10 },
  ) {
    super({});
  }

  _llmType() {
    return "tracked-fake";
  }

  async _generate(): Promise<ChatResult> {
    const scripted = this.script[this.calls++];
    if (!scripted) throw new Error(`El guion no tiene respuesta para la llamada ${this.calls}`);
    const message = new AIMessage({
      content: scripted.content,
      tool_calls: scripted.tool_calls ?? [],
      response_metadata: { model: this.modelName },
      usage_metadata: { input_tokens: this.tokens.input, output_tokens: this.tokens.output, total_tokens: this.tokens.input + this.tokens.output },
    });
    return { generations: [{ text: message.text, message }] };
  }
}
