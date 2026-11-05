import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { ApprovalRequest } from "../graph/approval.js";
import { INTENTS, type Intent } from "../graph/intents.js";
import { AGENT_NODE_NAMES, type AgentNode } from "../graph/plan.js";
import { SECTIONS, type ReportPart } from "../graph/report/state.js";
import type { TurnResult } from "../graph/run-turn.js";
import { isActionName } from "../tools/actions/schemas.js";
import type { RetryNotice } from "../tools/retry-events.js";

// Los eventos de la interfaz (fase 9, R11): lo que el servidor le manda al navegador mientras corre un turno.
// `toUiEvents` traduce cada dato de `graph.stream` (modos values, updates y messages, con subgrafos) a estos eventos.
// Es una función pura: toda la lógica de "qué se muestra" está acá, con tests, y no en el navegador.

const agentSchema = z.enum(AGENT_NODE_NAMES as [AgentNode, ...AgentNode[]]);
/** Quién escribió un mensaje: un agente, o el supervisor (los avisos del plan). */
const authorSchema = z.union([agentSchema, z.literal("supervisor")]);
export type Author = z.infer<typeof authorSchema>;

export const uiEventSchema = z.discriminatedUnion("type", [
  /** Las partes del pedido, en el orden en que se hacen (el plan del router). */
  z.object({
    type: z.literal("route"),
    reason: z.string().optional(),
    tasks: z.array(z.object({ intent: z.enum(INTENTS), request: z.string() })),
  }),
  /** Un agente empieza o termina su parte. */
  z.object({ type: z.literal("agent"), agent: agentSchema, status: z.enum(["start", "end"]) }),
  /** Un pedazo del texto que está escribiendo un modelo. */
  z.object({ type: z.literal("token"), messageId: z.string(), agent: agentSchema, text: z.string() }),
  /**
   * Un mensaje terminado. `reply`: le contesta a la persona. `step`: el texto que acompaña a una herramienta («voy a
   * consultar…»). `notice`: un aviso del plan. Reemplaza al borrador de tokens del mismo autor.
   */
  z.object({ type: z.literal("message"), id: z.string(), author: authorSchema, kind: z.enum(["reply", "step", "notice"]), text: z.string() }),
  /** El agente pidió una herramienta de consulta. */
  z.object({ type: z.literal("tool_start"), id: z.string(), agent: agentSchema, name: z.string(), args: z.record(z.string(), z.unknown()) }),
  /** La herramienta terminó. No viaja su contenido (son datos de la base que ya usó el modelo). */
  z.object({ type: z.literal("tool_end"), id: z.string(), name: z.string(), ok: z.boolean() }),
  /** El resultado de una acción decidida, con el texto que armó el código. */
  z.object({ type: z.literal("action_result"), tool: z.string(), ok: z.boolean(), message: z.string() }),
  /**
   * Una lectura de la base falló de forma transitoria y se va a reintentar (fase 10, modo `custom`). `target` es la
   * herramienta (`getStockLevels`) o la sección del reporte (`section:stock`); `attempt`, el intento que viene.
   */
  z.object({ type: z.literal("retry"), agent: agentSchema.optional(), target: z.string(), attempt: z.number().int(), attempts: z.number().int() }),
  /** Una sección de un reporte terminó. */
  z.object({ type: z.literal("report_section"), section: z.enum(SECTIONS), status: z.enum(["ok", "error"]) }),
  /** El grafo se pausó: una acción espera la decisión de la persona (la tarjeta). */
  z.object({ type: z.literal("approval"), request: z.custom<ApprovalRequest>((v) => (v as ApprovalRequest)?.kind === "approve_action") }),
  /** El turno terminó (o quedó esperando una decisión): el mismo resultado que devuelve `runTurn`. */
  z.object({ type: z.literal("done"), result: z.custom<TurnResult>((v) => typeof v === "object" && v !== null) }),
  /** El turno falló. `pending`: el hilo quedó a medias y se puede continuar. */
  z.object({ type: z.literal("error"), message: z.string(), pending: z.boolean() }),
]);
export type UiEvent = z.infer<typeof uiEventSchema>;

/** Un dato de `graph.stream` con `subgraphs: true` y varios modos: `[namespace, modo, dato]`. */
export type StreamChunk = [namespace: string[], mode: string, data: unknown];

/**
 * Los nodos cuyo texto se transmite token por token: los que le contestan a la persona con texto libre.
 * Quedan afuera los de salida estructurada (router, memoria, período del reporte) y la «Lectura» del reporte, que el
 * código puede descartar si cita cifras que no están en los datos (fase 6): se vería un texto que después desaparece.
 */
// La clave es `<primer tramo del namespace>/<nodo>`. Un nodo del grafo principal (charla, aclaración) transmite con su
// propio tramo (`chat:uuid`): su clave es `chat/chat`.
const STREAMED_NODES: Partial<Record<string, AgentNode>> = {
  "query_graph/agent": "query_graph",
  "action_graph/action_agent": "action_graph",
  "chat/chat": "chat",
  "clarify/clarify": "clarify",
};

/** `query_graph:uuid|agent:uuid` → `query_graph`. */
const graphNameOf = (namespace: string[]) => namespace[0]?.split(":")[0] ?? "";
const isAgent = (name: string): name is AgentNode => (AGENT_NODE_NAMES as string[]).includes(name);

function messageEvent(message: BaseMessage, author: Author): UiEvent | undefined {
  if (!AIMessage.isInstance(message) && !AIMessageChunk.isInstance(message)) return undefined;
  const text = message.text.trim();
  if (!text) return undefined;
  const kind = author === "supervisor" ? "notice" : message.tool_calls?.length ? "step" : "reply";
  return { type: "message", id: message.id ?? "", author, kind, text };
}

function toolEvents(message: BaseMessage, agent: AgentNode): UiEvent[] {
  if (!AIMessage.isInstance(message) && !AIMessageChunk.isInstance(message)) return [];
  // Las acciones no son herramientas que se ejecutan: se proponen y se ven en la tarjeta.
  return (message.tool_calls ?? [])
    .filter((call) => !isActionName(call.name))
    .map((call) => ({ type: "tool_start", id: call.id ?? "", agent, name: call.name, args: call.args }));
}

function toolResultEvent(message: BaseMessage): UiEvent | undefined {
  if (!ToolMessage.isInstance(message)) return undefined;
  const ok = message.status !== "error";
  if (message.name && isActionName(message.name)) return { type: "action_result", tool: message.name, ok, message: message.text };
  return { type: "tool_end", id: message.tool_call_id, name: message.name ?? "", ok };
}

/** Lo que devuelve un nodo (solo los campos que importan para la interfaz). */
interface Update {
  messages?: BaseMessage[];
  plan?: { tasks: { intent: Intent; request: string }[] };
  intentReason?: string;
  activeAgent?: string | null;
  reportParts?: ReportPart[];
}

/** Lo que hizo un nodo del grafo PRINCIPAL. Los subgrafos devuelven ahí todos sus mensajes juntos: esos no se repiten. */
function rootUpdate(node: string, update: Update): UiEvent[] {
  if (node === "__interrupt__") {
    const values = (update as unknown as { value: unknown }[]).map((i) => i.value as ApprovalRequest);
    const request = values.find((v) => v?.kind === "approve_action");
    return request ? [{ type: "approval", request }] : [];
  }
  if (node === "router" && update.plan) {
    return [
      {
        type: "route",
        ...(update.intentReason && { reason: update.intentReason }),
        tasks: update.plan.tasks.map((t) => ({ intent: t.intent, request: t.request })),
      },
    ];
  }
  if (node === "supervisor") {
    const events: UiEvent[] = [];
    for (const m of update.messages ?? []) {
      const e = messageEvent(m, "supervisor");
      if (e) events.push(e);
    }
    if (update.activeAgent && isAgent(update.activeAgent)) events.push({ type: "agent", agent: update.activeAgent, status: "start" });
    return events;
  }
  if (!isAgent(node)) return [];
  const events: UiEvent[] = [];
  // Los nodos sueltos (charla, aclaración, memoria) contestan acá; los subgrafos ya informaron sus mensajes adentro.
  if (!node.endsWith("_graph")) {
    for (const m of update.messages ?? []) {
      const e = messageEvent(m, node);
      if (e) events.push(e);
    }
  }
  events.push({ type: "agent", agent: node, status: "end" });
  return events;
}

/** Lo que hizo un nodo DENTRO de un subgrafo (agente de consultas, de acciones o reportes). */
function subgraphUpdate(agent: AgentNode, node: string, update: Update): UiEvent[] {
  if (node === "__interrupt__") return []; // la misma pausa llega también al grafo principal
  const events: UiEvent[] = [];
  for (const part of update.reportParts ?? []) events.push({ type: "report_section", section: part.section, status: part.status });
  for (const m of update.messages ?? []) {
    const message = messageEvent(m, agent);
    if (message) events.push(message);
    events.push(...toolEvents(m, agent));
    const result = toolResultEvent(m);
    if (result) events.push(result);
  }
  return events;
}

/** Traduce un dato de `graph.stream` a los eventos de la interfaz (puede no dar ninguno). */
export function toUiEvents([namespace, mode, data]: StreamChunk): UiEvent[] {
  if (mode === "custom") {
    const notice = data as Partial<RetryNotice> | undefined;
    if (notice?.kind !== "retry" || typeof notice.target !== "string") return [];
    const graph = graphNameOf(namespace);
    return [{ type: "retry", ...(isAgent(graph) && { agent: graph }), target: notice.target, attempt: Number(notice.attempt), attempts: Number(notice.attempts) }];
  }
  if (mode === "messages") {
    const [chunk, metadata] = data as [BaseMessage, Record<string, unknown>];
    if (!AIMessageChunk.isInstance(chunk)) return [];
    const agent = STREAMED_NODES[`${graphNameOf(namespace)}/${String(metadata?.langgraph_node ?? "")}`];
    const text = chunk.text;
    if (!agent || !text || !chunk.id) return [];
    return [{ type: "token", messageId: chunk.id, agent, text }];
  }
  if (mode !== "updates") return [];
  const events: UiEvent[] = [];
  for (const [node, update] of Object.entries(data as Record<string, Update>)) {
    if (!update) continue;
    if (namespace.length === 0) events.push(...rootUpdate(node, update));
    else {
      const graph = graphNameOf(namespace);
      if (isAgent(graph)) events.push(...subgraphUpdate(graph, node, update));
    }
  }
  return events;
}
