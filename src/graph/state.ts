import type { BaseMessage } from "@langchain/core/messages";
import { MessagesValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { approvalSchema, pendingActionSchema } from "./approval.js";
import { INTENTS } from "./intents.js";

// MessagesValue es un campo con reducer: cada nodo devuelve mensajes nuevos
// y LangGraph los agrega al historial en lugar de reemplazarlo.
// `intent` no tiene reducer: el último valor escrito reemplaza al anterior (lo escribe el router).
export const AgentState = new StateSchema({
  messages: MessagesValue,
  intent: z.enum(INTENTS).optional(),
  // Por qué el router eligió esa ruta: se muestra en la terminal y servirá al inspeccionar checkpoints.
  intentReason: z.string().optional(),
  // Acción que el modelo pidió y espera la decisión de la persona (fase 5). Sin reducer; `null` cuando no hay ninguna.
  pendingAction: pendingActionSchema.nullable().optional(),
  // Decisión ya procesada sobre esa acción. `null` cuando no hay ninguna.
  approval: approvalSchema.nullable().optional(),
});

export type AgentStateType = typeof AgentState.State;

/** Estado completo para llamar a un nodo suelto (fuera de un grafo), por ejemplo en tests y evaluaciones. */
export const makeState = (messages: BaseMessage[], overrides: Partial<AgentStateType> = {}): AgentStateType => ({
  messages,
  intent: undefined,
  intentReason: undefined,
  pendingAction: undefined,
  approval: undefined,
  ...overrides,
});
