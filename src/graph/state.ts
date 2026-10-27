import { MessagesValue, StateSchema } from "@langchain/langgraph";

// MessagesValue es un campo con reducer: cada nodo devuelve mensajes nuevos
// y LangGraph los agrega al historial en lugar de reemplazarlo.
export const AgentState = new StateSchema({
  messages: MessagesValue,
});

export type AgentStateType = typeof AgentState.State;
