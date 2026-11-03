import { readFileSync } from "node:fs";
import type { BaseMessage } from "@langchain/core/messages";
import { describeNow } from "../../tools/dates.js";
import { agentInput, type TaskState } from "../plan.js";

/**
 * Lo mínimo que el nodo necesita del modelo. En producción es ChatAnthropic con las
 * herramientas ya enlazadas (bindTools); en los tests, un modelo falso guionado.
 */
export interface AgentModel {
  invoke(messages: BaseMessage[]): Promise<BaseMessage>;
}

const systemTemplate = readFileSync(new URL("../prompts/system.md", import.meta.url), "utf8");

/** El prompt lleva la fecha de hoy en cada llamada: sin ella, "mañana" no significa nada. */
export function renderSystemPrompt(now: Date) {
  return systemTemplate.replace("{{currentDateTime}}", describeNow(now));
}

/**
 * Un nodo es una función (estado) => actualización parcial del estado.
 * Si la respuesta trae tool_calls, la arista condicional manda el grafo al nodo de
 * herramientas; si no, la conversación termina. El reducer agrega la respuesta a `messages`.
 * Si el turno tiene varias tareas (fase 7), el prompt dice cuál le toca (ver `agentInput`).
 */
export function makeAgentNode(model: AgentModel, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return async (state: TaskState) => {
    const reply = await model.invoke(agentInput(renderSystemPrompt(now()), state));
    return { messages: [reply] };
  };
}
