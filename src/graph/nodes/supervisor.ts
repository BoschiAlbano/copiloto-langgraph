import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { Command, END } from "@langchain/langgraph";
import { AGENT_NODES, type Plan } from "../plan.js";

/**
 * El supervisor (fase 7): código, sin modelo. Recorre el plan que dejó el router y TRASPASA el control al agente de
 * cada tarea, de a una:
 *  - la tarea que estaba en curso (si volvió un agente) queda `done`;
 *  - la siguiente `pending` pasa a `running`, con la cantidad de mensajes del hilo en ese momento (`startedAt`, para
 *    que su agente sepa dónde empieza lo suyo), y se va a su agente;
 *  - sin tareas pendientes, el turno termina (con el aviso del plan, si lo hay).
 *
 * En vez de escribir el estado y dejar que una arista condicional elija el destino, devuelve un `Command`: la
 * actualización y el próximo nodo juntos. Los destinos posibles se declaran al agregar el nodo (`ends`).
 */
export function supervise(state: { messages: BaseMessage[]; plan?: Plan }): Command {
  const plan = state.plan;
  if (!plan) return new Command({ goto: END, update: { activeAgent: null } });

  const tasks = plan.tasks.map((t) => (t.status === "running" ? { ...t, status: "done" as const } : t));
  const index = tasks.findIndex((t) => t.status === "pending");
  if (index === -1) {
    return new Command({
      goto: END,
      update: { plan: { ...plan, tasks }, activeAgent: null, ...(plan.notice && { messages: [new AIMessage(plan.notice)] }) },
    });
  }
  const task = { ...tasks[index]!, status: "running" as const, startedAt: state.messages.length };
  tasks[index] = task;
  const agent = AGENT_NODES[task.intent];
  return new Command({ goto: agent, update: { plan: { ...plan, tasks }, activeAgent: agent } });
}
