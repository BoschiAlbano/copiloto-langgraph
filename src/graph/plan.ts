import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { renderBusinessContext, type BusinessMemory } from "../memory/context.js";
import { INTENTS, routerOutputSchema, type Intent } from "./intents.js";

// El plan de un turno (fase 7): el router parte el pedido en tareas y el supervisor las recorre en orden, una por
// agente. El modelo propone las tareas; las reglas de R5 (qué se descarta, qué va primero) las aplica el código.

export const TASK_STATUSES = ["pending", "running", "done"] as const;

export const taskSchema = z.object({
  /** "1", "2", "3": la posición en el plan. */
  id: z.string().min(1),
  intent: z.enum(INTENTS),
  /** La parte del pedido que le toca a esta tarea, escrita para que se entienda sola. */
  request: z.string().min(1),
  status: z.enum(TASK_STATUSES),
  /** Cuántos mensajes tenía el hilo cuando el supervisor despachó la tarea: ahí empieza lo que escribe su agente. */
  startedAt: z.number().int().min(0).optional(),
});
export type Task = z.infer<typeof taskSchema>;

export const planSchema = z.object({
  tasks: z.array(taskSchema),
  /** Aviso para la persona al final del turno, por ejemplo que una segunda acción quedó sin hacer. */
  notice: z.string().optional(),
});
export type Plan = z.infer<typeof planSchema>;

export const PLAN_FALLBACK_REASON = "Respaldo: la salida del router no cumplió el esquema.";

/** El aviso cuando el plan traía más de una acción: se hace la primera y la otra hay que pedirla después. */
export const secondActionNotice = (request: string) =>
  `Hago una sola acción por mensaje, así que no hice esto: «${request}». Pedímelo cuando quieras y lo preparo.`;

export interface NormalizedPlan {
  plan: Plan;
  /** La intención de la primera tarea: es la que leen el historial, la terminal y las evaluaciones de la fase 3. */
  intent: Intent;
  reason: string;
  /** La salida del modelo no cumplía el esquema y se usó el respaldo. */
  fallback: boolean;
}

const pending = (items: { intent: Intent; request: string }[]): Task[] =>
  items.map((t, i) => ({ id: String(i + 1), intent: t.intent, request: t.request, status: "pending" }));

/**
 * Convierte la salida del router en el plan que se ejecuta (R5):
 *  - salida inválida → una sola consulta con el mensaje completo (la rama de solo lectura, como en la fase 3);
 *  - una tarea `unclear` anula las demás: se pide aclaración antes de hacer nada;
 *  - la charla combinada con otras tareas se descarta;
 *  - una sola acción por mensaje (la primera); si había otra, el plan lleva un aviso;
 *  - la memoria va primero (fase 8: lo que se anota ya vale para las demás tareas del turno), después la acción, y el
 *    resto sigue en el orden pedido (una consulta del mismo mensaje tiene que ver el cambio);
 *  - las consultas seguidas se unen en una: un mismo agente puede contestar varias preguntas.
 */
export function normalizePlan(output: unknown, lastMessage: string): NormalizedPlan {
  const parsed = routerOutputSchema.safeParse(output);
  if (!parsed.success) {
    return { plan: { tasks: pending([{ intent: "query", request: lastMessage }]) }, intent: "query", reason: PLAN_FALLBACK_REASON, fallback: true };
  }
  const { reason, tasks } = parsed.data;
  const single = (intent: Intent, request: string): NormalizedPlan => ({ plan: { tasks: pending([{ intent, request }]) }, intent, reason, fallback: false });

  if (tasks.some((t) => t.intent === "unclear")) return single("unclear", lastMessage);
  const work = tasks.filter((t) => t.intent !== "chat");
  if (work.length === 0) return single("chat", lastMessage);

  const actions = work.filter((t) => t.intent === "action");
  const memories = work.filter((t) => t.intent === "memory");
  const ordered = [...memories, ...actions.slice(0, 1), ...work.filter((t) => t.intent !== "action" && t.intent !== "memory")];
  const merged: { intent: Intent; request: string }[] = [];
  for (const t of ordered) {
    const previous = merged.at(-1);
    if (previous?.intent === "query" && t.intent === "query") previous.request = `${previous.request} ${t.request}`;
    else merged.push({ intent: t.intent, request: t.request });
  }
  const notice = actions[1] ? secondActionNotice(actions[1].request) : undefined;
  return { plan: { tasks: pending(merged), ...(notice && { notice }) }, intent: merged[0]!.intent, reason, fallback: false };
}

/** Lo que un agente necesita para saber qué le toca: el historial y el plan del turno. */
export interface TaskState {
  messages: BaseMessage[];
  plan?: Plan;
  /** Las memorias del negocio (fase 8). */
  businessContext?: BusinessMemory[];
}

/** La tarea en curso, solo si el turno tiene más de una: con una sola, el agente se comporta como antes de la fase 7. */
export function sharedTask(state: Pick<TaskState, "plan">): Task | undefined {
  const tasks = state.plan?.tasks ?? [];
  return tasks.length > 1 ? tasks.find((t) => t.status === "running") : undefined;
}

/** Lo que se le suma al prompt del sistema de un agente cuando el pedido tiene varias partes (R7). */
export const taskPrompt = (task: Task) =>
  `\n\n## Tu parte de este pedido\nEl último mensaje de la persona pide varias cosas y cada una la atiende un agente distinto, en este mismo turno. ` +
  `A vos te toca solo esto: «${task.request}». No hagas ni contestes el resto: lo atienden los otros agentes. ` +
  `Respondé tu parte como si fuera todo el pedido: no menciones las otras partes, ni a otros agentes, ni lo que vos no hacés.`;

/** La indicación que separa la respuesta de otro agente del trabajo de este. No se guarda en el hilo. */
export const handoffMessage = (task: Task) => new HumanMessage(`[Indicación del copiloto] Seguí con tu parte del pedido: «${task.request}».`);

/**
 * Los mensajes que ve el modelo de un agente: el prompt del sistema (con su parte del pedido, si el turno tiene varias)
 * y el historial. Si la tarea arrancó justo después de la respuesta de OTRO agente, en ese punto se intercala una
 * indicación que no se guarda en el hilo: la API de Claude tomaría un mensaje de IA al final como un texto a
 * continuar, no como un pedido. Va en el punto de arranque (no al final) para que siga ahí en cada vuelta del ciclo.
 */
export function agentInput(base: string, state: TaskState): BaseMessage[] {
  // Las memorias del negocio (fase 8) van después de las reglas del agente y antes de su parte del pedido.
  const system = base + renderBusinessContext(state.businessContext);
  const task = sharedTask(state);
  if (!task) return [new SystemMessage(system), ...state.messages];
  const at = task.startedAt ?? state.messages.length;
  const before = state.messages.slice(0, at);
  const last = before.at(-1);
  const afterAnother = last !== undefined && AIMessage.isInstance(last) && !last.tool_calls?.length;
  return [
    new SystemMessage(system + taskPrompt(task)),
    ...before,
    ...(afterAnother ? [handoffMessage(task)] : []),
    ...state.messages.slice(at),
  ];
}

/**
 * El nodo del grafo principal que atiende cada intención: tres subgrafos (consultas, acciones y reportes) y dos nodos
 * simples (charla y aclaración). Al ser un Record<Intent, …>, TypeScript exige cubrirlas todas.
 */
export const AGENT_NODES = {
  query: "query_graph",
  action: "action_graph",
  report: "report_graph",
  chat: "chat",
  unclear: "clarify",
  memory: "memory",
} as const satisfies Record<Intent, string>;
export type AgentNode = (typeof AGENT_NODES)[Intent];
export const AGENT_NODE_NAMES = Object.values(AGENT_NODES) as [AgentNode, ...AgentNode[]];
