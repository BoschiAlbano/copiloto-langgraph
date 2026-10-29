import { AIMessage } from "@langchain/core/messages";
import { REPORT_STUB_MESSAGE } from "../messages.js";

// Marcador de una rama que se construye en una fase siguiente (reportes: fase 6).
// No llama a ningún modelo: responde con un mensaje fijo y el grafo termina.
// (El marcador de acciones desapareció en la fase 5: ahora la rama `action` es real.)

export const reportStubNode = async () => ({ messages: [new AIMessage(REPORT_STUB_MESSAGE)] });
