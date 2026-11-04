import type { BaseMessage } from "@langchain/core/messages";
import { MessagesValue, ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { approvalSchema, pendingActionSchema } from "./approval.js";
import { INTENTS } from "./intents.js";
import { AGENT_NODE_NAMES, planSchema } from "./plan.js";
import { businessMemorySchema } from "../memory/context.js";
import { mergeParts, partSchema, reportSchema } from "./report/state.js";

// Estado del grafo PRINCIPAL (fase 7): lo que comparten el router, el supervisor y los agentes.
// MessagesValue es un campo con reducer: cada nodo devuelve mensajes nuevos
// y LangGraph los agrega al historial en lugar de reemplazarlo.
// Los demás campos no tienen reducer: el último valor escrito reemplaza al anterior.
export const AgentState = new StateSchema({
  messages: MessagesValue,
  // La intención de la primera tarea del plan (la escribe el router).
  intent: z.enum(INTENTS).optional(),
  // Por qué el router eligió esa ruta: se muestra en la terminal y servirá al inspeccionar checkpoints.
  intentReason: z.string().optional(),
  // Las tareas del turno: las escribe el router y las recorre el supervisor. Se reemplaza en cada mensaje.
  plan: planSchema.optional(),
  // El agente que atiende la tarea en curso (lo escribe el supervisor); `null` cuando terminó el turno.
  activeAgent: z.enum(AGENT_NODE_NAMES).nullable().optional(),
  // Reporte del turno (fase 6): período, título y estado de cada sección. Lo comparte el subgrafo de reportes.
  report: reportSchema.optional(),
  // Las memorias del negocio (fase 8): las lee `load_memory` del Store al empezar cada turno. Se reemplaza.
  businessContext: z.array(businessMemorySchema).optional(),
});

export type AgentStateType = typeof AgentState.State;

// Estados de los subgrafos. Un subgrafo agregado como nodo recibe del grafo principal los campos que tienen el
// MISMO nombre en los dos esquemas, y al terminar devuelve solo esos: son el estado compartido. Los campos que el
// subgrafo tiene y el principal no son privados: viven en los checkpoints del subgrafo y nadie más los ve.

/** Consultas: solo lo compartido (el historial, el plan del turno para saber qué parte le toca y las memorias). */
export const QueryState = new StateSchema({
  messages: MessagesValue,
  plan: planSchema.optional(),
  businessContext: z.array(businessMemorySchema).optional(),
});
export type QueryStateType = typeof QueryState.State;

/**
 * Reportes: comparte `report` (período, título y estado de cada sección, que muestra la terminal). Las partes son
 * PRIVADAS: las escriben las tres secciones a la vez (con el reducer que las junta) y solo las lee `compose_report`.
 */
export const ReportState = new StateSchema({
  messages: MessagesValue,
  plan: planSchema.optional(),
  report: reportSchema.optional(),
  reportParts: new ReducedValue(z.array(partSchema).default([]), { reducer: mergeParts }),
});
export type ReportStateType = typeof ReportState.State;

/**
 * Acciones: la propuesta y la decisión son PRIVADAS. Viven en los checkpoints del subgrafo, sobreviven a la pausa
 * (`interrupt`) y a un reinicio, y la tarjeta se reconstruye leyendo el estado del subgrafo (`getStatus`).
 */
export const ActionState = new StateSchema({
  messages: MessagesValue,
  plan: planSchema.optional(),
  // Compartido (fase 8): una regla del negocio puede impedir proponer una acción.
  businessContext: z.array(businessMemorySchema).optional(),
  // Acción que el modelo pidió y espera la decisión de la persona (fase 5). Sin reducer; `null` cuando no hay ninguna.
  pendingAction: pendingActionSchema.nullable().optional(),
  // Decisión ya procesada sobre esa acción. `null` cuando no hay ninguna.
  approval: approvalSchema.nullable().optional(),
});
export type ActionStateType = typeof ActionState.State;

/** Todos los campos que puede leer algún nodo: el estado principal más los privados de cada subgrafo. */
export type NodeState = AgentStateType & Omit<ActionStateType, keyof AgentStateType> & Omit<ReportStateType, keyof AgentStateType>;

/** Estado para llamar a un nodo suelto (fuera de un grafo), por ejemplo en tests y evaluaciones. */
export const makeState = (messages: BaseMessage[], overrides: Partial<NodeState> = {}): NodeState => ({
  messages,
  intent: undefined,
  intentReason: undefined,
  plan: undefined,
  activeAgent: undefined,
  report: undefined,
  businessContext: undefined,
  pendingAction: undefined,
  approval: undefined,
  reportParts: [],
  ...overrides,
});
