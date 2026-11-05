import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import { streamRunTurn, resumeTurn } from "../src/graph/run-turn.js";
import { getStatus } from "../src/graph/threads.js";
import { findTurnStart, streamForkTurn, streamReplayTurn, TurnNotFoundError } from "../src/graph/time-travel.js";
import type { UiEvent } from "../src/web/events.js";
import { makeHandlers, type ThreadView } from "../src/web/handlers.js";
import { readSse } from "../src/web/sse.js";
import { fakeActions } from "./helpers/actions.js";
import { buildTestGraph } from "./helpers/graph.js";
import { scriptedModel, StreamingChatModel, toolCall } from "./helpers/models.js";

// Fase 10 (T6, R10 a R14, CA4 sin modelo real): editar y reintentar un turno son ramas nuevas del hilo.

async function all(events: AsyncIterable<UiEvent>) {
  const out: UiEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
const texts = async (graph: Parameters<typeof getStatus>[0], id: string) => (await getStatus(graph, id)).messages.map((m) => m.text);

/** Charla que contesta "eco: <mensaje>" y numera sus respuestas (para distinguir un reintento). */
function echoGraph() {
  const { model, calls } = scriptedModel((n, msgs) => new AIMessage(`eco ${n + 1}: ${msgs.findLast((m) => m.type === "human")?.text}`));
  const graph = buildTestGraph({ model, tools: [], intent: "chat", checkpointer: new MemorySaver() });
  return { graph, calls };
}
async function say(graph: ReturnType<typeof echoGraph>["graph"], id: string, text: string) {
  const events = await all(streamRunTurn({ graph }, id, text));
  const turn = events[0];
  if (turn?.type !== "turn") throw new Error("el primer evento no es turn");
  return turn.humanMessageId;
}

describe("el evento turn (R12)", () => {
  it("cada turno nuevo avisa primero el id de su mensaje, que es el que queda en el hilo", async () => {
    const { graph } = echoGraph();
    const events = await all(streamRunTurn({ graph }, "h", "hola"));
    expect(events[0]).toMatchObject({ type: "turn", kind: "new" });
    const id = events[0]!.type === "turn" ? events[0].humanMessageId : "";
    const human = (await getStatus(graph, "h")).messages.find((m) => HumanMessage.isInstance(m));
    expect(human?.id).toBe(id);
  });
});

describe("editar y reintentar (R10, R11)", () => {
  it("editar el segundo turno: rama nueva con el mensaje nuevo; la original queda en la historia", async () => {
    const { graph } = echoGraph();
    await say(graph, "h", "hola");
    const second = await say(graph, "h", "¿y mañana?");
    expect(await texts(graph, "h")).toEqual(["hola", "eco 1: hola", "¿y mañana?", "eco 2: ¿y mañana?"]);

    const events = await all(streamForkTurn({ graph }, "h", second, "¿y pasado mañana?"));
    expect(events[0]).toMatchObject({ type: "turn", kind: "edit" });
    expect(events.at(-1)).toMatchObject({ type: "done", result: { reply: "eco 3: ¿y pasado mañana?" } });
    // El estado del hilo es la rama nueva…
    expect(await texts(graph, "h")).toEqual(["hola", "eco 1: hola", "¿y pasado mañana?", "eco 3: ¿y pasado mañana?"]);
    // …y la rama original sigue en la historia.
    const all_: string[] = [];
    for await (const s of graph.getStateHistory({ configurable: { thread_id: "h" } })) all_.push(...(s.values.messages ?? []).map((m: { text: string }) => m.text));
    expect(all_).toContain("eco 2: ¿y mañana?");
  });

  it("también se puede editar el primer mensaje del hilo", async () => {
    const { graph } = echoGraph();
    const first = await say(graph, "h", "hola");
    await say(graph, "h", "chau");
    await all(streamForkTurn({ graph }, "h", first, "buenas"));
    expect(await texts(graph, "h")).toEqual(["buenas", "eco 3: buenas"]);
  });

  it("reintentar: el mismo mensaje, otra respuesta, sin duplicar el mensaje de la persona", async () => {
    const { graph } = echoGraph();
    const first = await say(graph, "h", "hola");
    const events = await all(streamReplayTurn({ graph }, "h", first));
    expect(events[0]).toMatchObject({ type: "turn", kind: "retry" });
    expect(await texts(graph, "h")).toEqual(["hola", "eco 2: hola"]);
  });

  it("después de editar, se puede editar el mensaje nuevo (el id del evento turn)", async () => {
    const { graph } = echoGraph();
    const first = await say(graph, "h", "a");
    const edited = await all(streamForkTurn({ graph }, "h", first, "b"));
    const newId = edited[0]!.type === "turn" ? edited[0].humanMessageId : "";
    await all(streamForkTurn({ graph }, "h", newId, "c"));
    expect(await texts(graph, "h")).toEqual(["c", "eco 3: c"]);
  });

  it("un mensaje que no está en la rama actual (por ejemplo, la versión anterior de uno editado) no se encuentra", async () => {
    const { graph } = echoGraph();
    const first = await say(graph, "h", "a");
    await all(streamForkTurn({ graph }, "h", first, "b"));
    await expect(findTurnStart(graph, "h", first)).rejects.toBeInstanceOf(TurnNotFoundError);
    await expect(findTurnStart(graph, "h", "no-existe")).rejects.toBeInstanceOf(TurnNotFoundError);
  });
});

describe("con acciones (R13)", () => {
  it("editar un turno con una acción ya ejecutada: no se deshace (se avisa), y la rama nueva propone otra que hay que aprobar", async () => {
    const actions = fakeActions();
    const model = scriptedModel([
      toolCall("a1", "adjustStock", { sku: "CER-001", delta: 5, reason: "pedido" }),
      new AIMessage("Listo, sumé 5."),
      toolCall("a2", "adjustStock", { sku: "CER-001", delta: 8, reason: "pedido" }),
      new AIMessage("Listo, sumé 8."),
    ]);
    const graph = buildTestGraph({ model: model.model, tools: [], intent: "action", actions: actions.runner, checkpointer: new MemorySaver() });
    const first = await say(graph as never, "h", "sumá 5 ceras");
    await resumeTurn({ graph }, "h", { decision: "approve" });
    expect(actions.executed).toHaveLength(1);

    const events = await all(streamForkTurn({ graph }, "h", first, "sumá 8 ceras"));
    expect(events[0]).toMatchObject({ type: "turn", kind: "edit", replacedActions: [expect.stringMatching(/^Hecho: adjustStock/)] });
    expect(events.find((e) => e.type === "approval")).toMatchObject({ request: { action: { params: { delta: 8 } } } });
    expect(actions.executed).toHaveLength(1); // nada nuevo sin aprobar
    expect((await getStatus(graph, "h")).awaiting).toBeDefined();
  });
});

describe("rutas edit y retry (R13, R14)", () => {
  const ORIGIN = "http://127.0.0.1:3000";
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, host: "127.0.0.1:3000", ...headers }, body: JSON.stringify(body) });
  const events = async (response: Response) => {
    expect(response.status).toBe(200);
    const out: UiEvent[] = [];
    for await (const e of readSse(response.body!)) out.push(e);
    return out;
  };

  it("editar por la web: SSE con la respuesta nueva; GET muestra la rama nueva", async () => {
    const { graph } = echoGraph();
    const handlers = makeHandlers({ graph, listThreads: async () => [] });
    const first = await say(graph, "h", "hola");
    const list = await events(await handlers.postEdit(post("/api/threads/h/edit", { messageId: first, text: "buenas" }), "h"));
    expect(list[0]).toMatchObject({ type: "turn", kind: "edit" });
    const view = (await (await handlers.getThread("h")).json()) as ThreadView;
    expect(view.messages.map((m) => m.text)).toEqual(["buenas", "eco 2: buenas"]);
    const retried = await events(await handlers.postRetry(post("/api/threads/h/retry", { messageId: view.messages[0]!.id }), "h"));
    expect(retried[0]).toMatchObject({ type: "turn", kind: "retry" });
  });

  it("los mismos controles que un mensaje nuevo, y 404 si el mensaje no está en la conversación", async () => {
    const { graph } = echoGraph();
    const handlers = makeHandlers({ graph, listThreads: async () => [] });
    const first = await say(graph, "h", "hola");
    expect((await handlers.postEdit(post("/api/threads/h/edit", { messageId: first, text: "x" }, { origin: "https://ajena.example" }), "h")).status).toBe(403);
    expect((await handlers.postEdit(post("/api/threads/h/edit", { messageId: first, text: "  " }), "h")).status).toBe(400);
    expect((await handlers.postRetry(post("/api/threads/h/retry", { messageId: first, extra: 1 }), "h")).status).toBe(400);
    expect((await handlers.postRetry(post("/api/threads/h/retry", { messageId: "no-existe" }), "h")).status).toBe(404);
  });

  it("con una tarjeta pendiente: 409", async () => {
    const actions = fakeActions();
    const model = scriptedModel([toolCall("a1", "adjustStock", { sku: "CER-001", delta: 5, reason: "pedido" })]);
    const graph = buildTestGraph({ model: model.model, tools: [], intent: "action", actions: actions.runner, checkpointer: new MemorySaver() });
    const handlers = makeHandlers({ graph, listThreads: async () => [] });
    const first = await say(graph as never, "h", "sumá 5");
    expect((await handlers.postEdit(post("/api/threads/h/edit", { messageId: first, text: "sumá 6" }), "h")).status).toBe(409);
    expect((await handlers.postRetry(post("/api/threads/h/retry", { messageId: first }), "h")).status).toBe(409);
  });

  it("con un turno en curso: 409, y el turno en curso termina normalmente", async () => {
    const graph = buildTestGraph({
      model: new StreamingChatModel([new AIMessage("primera"), new AIMessage("una respuesta que tarda en escribirse")], { delayMs: 20 }),
      tools: [],
      intent: "chat",
      checkpointer: new MemorySaver(),
    });
    const handlers = makeHandlers({ graph, listThreads: async () => [] });
    const first = await say(graph as never, "h", "hola");
    const running = await handlers.postMessage(post("/api/threads/h/messages", { text: "contame" }), "h");
    expect((await handlers.postEdit(post("/api/threads/h/edit", { messageId: first, text: "buenas" }), "h")).status).toBe(409);
    expect((await handlers.postRetry(post("/api/threads/h/retry", { messageId: first }), "h")).status).toBe(409);
    const list = await events(running);
    expect(list.at(-1)).toMatchObject({ type: "done" });
  });

  it("con un turno a medias: 409 (hay que continuarlo primero)", async () => {
    const LONG = "Una respuesta larga, que se escribe de a poco, para cortarla a la mitad sin que termine.";
    const graph = buildTestGraph({
      model: new StreamingChatModel([new AIMessage("primera"), new AIMessage(LONG)], { delayMs: 15 }),
      tools: [],
      intent: "chat",
      checkpointer: new MemorySaver(),
    });
    const handlers = makeHandlers({ graph, listThreads: async () => [] });
    const first = await say(graph as never, "h", "hola");
    const reader = (await handlers.postMessage(post("/api/threads/h/messages", { text: "contame" }), "h")).body!.getReader();
    // Hasta que llega parte de la respuesta (el primer evento, `turn`, sale antes de que el turno empiece a guardarse).
    const decoder = new TextDecoder();
    for (let seen = ""; !seen.includes(`"type":"token"`); ) seen += decoder.decode((await reader.read()).value);
    await reader.cancel(); // la persona recargó la página: el segundo turno queda a medias
    await vi.waitFor(async () => {
      expect((await getStatus(graph, "h")).pending).toBe(true);
      expect((await (await handlers.getThread("h")).json()) as ThreadView).toMatchObject({ running: false });
    });
    expect((await handlers.postEdit(post("/api/threads/h/edit", { messageId: first, text: "buenas" }), "h")).status).toBe(409);
    expect((await handlers.postRetry(post("/api/threads/h/retry", { messageId: first }), "h")).status).toBe(409);
  });
});

