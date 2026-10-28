import { AIMessage } from "@langchain/core/messages";
import { ACTION_STUB_MESSAGE, REPORT_STUB_MESSAGE } from "../messages.js";

// Marcadores de ramas que se construyen en fases siguientes (acciones: fase 5, reportes: fase 6).
// No llaman a ningún modelo: responden con un mensaje fijo y el grafo termina.

export const actionStubNode = async () => ({ messages: [new AIMessage(ACTION_STUB_MESSAGE)] });
export const reportStubNode = async () => ({ messages: [new AIMessage(REPORT_STUB_MESSAGE)] });
