import { MessagesValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { INTENTS } from "./intents.js";

// MessagesValue es un campo con reducer: cada nodo devuelve mensajes nuevos
// y LangGraph los agrega al historial en lugar de reemplazarlo.
// `intent` no tiene reducer: el último valor escrito reemplaza al anterior (lo escribe el router).
export const AgentState = new StateSchema({
  messages: MessagesValue,
  intent: z.enum(INTENTS).optional(),
  // Por qué el router eligió esa ruta: se muestra en la terminal y servirá al inspeccionar checkpoints.
  intentReason: z.string().optional(),
});

export type AgentStateType = typeof AgentState.State;
