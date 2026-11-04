import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
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

/**
 * Modelo falso que TRANSMITE (fase 9): cuando alguien escucha los tokens (el modo `messages` de LangGraph), entrega el
 * texto de a pedazos —una palabra por fragmento, con su espacio— y al final las llamadas a herramientas y el uso. Si
 * nadie escucha, contesta todo junto. Sirve para probar el streaming sin API. `delayMs` hace lento cada fragmento
 * (para probar el corte a mitad de un turno).
 */
export class StreamingChatModel extends BaseChatModel {
  calls = 0;

  constructor(
    private readonly script: AIMessage[],
    private readonly options: { modelName?: string; delayMs?: number } = {},
  ) {
    super({});
  }

  _llmType() {
    return "streaming-fake";
  }

  private next(): AIMessage {
    const scripted = this.script[this.calls++];
    if (!scripted) throw new Error(`El guion no tiene respuesta para la llamada ${this.calls}`);
    return scripted;
  }

  private meta() {
    return {
      response_metadata: { model: this.options.modelName ?? "claude-haiku-5-5" },
      usage_metadata: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    };
  }

  async _generate(): Promise<ChatResult> {
    const scripted = this.next();
    const message = new AIMessage({ content: scripted.content, tool_calls: scripted.tool_calls ?? [], ...this.meta() });
    return { generations: [{ text: message.text, message }] };
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const scripted = this.next();
    const pieces = scripted.text.match(/\S+\s*|\s+/g) ?? [];
    for (const piece of pieces) {
      if (this.options.delayMs) await new Promise((r) => setTimeout(r, this.options.delayMs));
      options.signal?.throwIfAborted();
      const chunk = new ChatGenerationChunk({ text: piece, message: new AIMessageChunk({ content: piece }) });
      yield chunk;
      await runManager?.handleLLMNewToken(piece, undefined, undefined, undefined, undefined, { chunk });
    }
    // El cierre: las llamadas a herramientas (si hay) y el uso, sin texto.
    yield new ChatGenerationChunk({
      text: "",
      message: new AIMessageChunk({
        content: "",
        tool_call_chunks: (scripted.tool_calls ?? []).map((c, index) => ({
          id: c.id,
          name: c.name,
          args: JSON.stringify(c.args),
          index,
          type: "tool_call_chunk" as const,
        })),
        ...this.meta(),
      }),
    });
  }
}
