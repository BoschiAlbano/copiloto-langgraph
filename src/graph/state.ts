import type { BaseMessage } from "@langchain/core/messages";
import { MessagesValue, ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { approvalSchema, pendingActionSchema } from "./approval.js";
import { INTENTS } from "./intents.js";
import { planSchema } from "./plan.js";
import { mergeParts, partSchema, reportSchema } from "./report/state.js";

// MessagesValue es un campo con reducer: cada nodo devuelve mensajes nuevos
// y LangGraph los agrega al historial en lugar de reemplazarlo.
// `intent` no tiene reducer: el último valor escrito reemplaza al anterior (lo escribe el router).
export const AgentState = new StateSchema({
  messages: MessagesValue,
  intent: z.enum(INTENTS).optional(),
  // Por qué el router eligió esa ruta: se muestra en la terminal y servirá al inspeccionar checkpoints.
  intentReason: z.string().optional(),
  // Las tareas del turno (fase 7): las escribe el router y las recorre el supervisor. Se reemplaza en cada mensaje.
  plan: planSchema.optional(),
  // Acción que el modelo pidió y espera la decisión de la persona (fase 5). Sin reducer; `null` cuando no hay ninguna.
  pendingAction: pendingActionSchema.nullable().optional(),
  // Decisión ya procesada sobre esa acción. `null` cuando no hay ninguna.
  approval: approvalSchema.nullable().optional(),
  // Reporte en curso (fase 6): período y título. Se reemplaza en cada pedido de reporte.
  report: reportSchema.optional(),
  // Resultados de las tres secciones del reporte. CON reducer: las tres secciones escriben en el mismo paso y sus
  // partes se concatenan; un reporte nuevo (otro `reportId`) reemplaza todo lo anterior.
  reportParts: new ReducedValue(z.array(partSchema).default([]), { reducer: mergeParts }),
});

export type AgentStateType = typeof AgentState.State;

/** Estado completo para llamar a un nodo suelto (fuera de un grafo), por ejemplo en tests y evaluaciones. */
export const makeState = (messages: BaseMessage[], overrides: Partial<AgentStateType> = {}): AgentStateType => ({
  messages,
  intent: undefined,
  intentReason: undefined,
  plan: undefined,
  pendingAction: undefined,
  approval: undefined,
  report: undefined,
  reportParts: [],
  ...overrides,
});
