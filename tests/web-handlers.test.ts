import { AIMessage } from "@langchain/core/messages";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import type { AgentModel } from "../src/graph/nodes/agent.js";
import { getStatus } from "../src/graph/threads.js";
import { saveMemory } from "../src/memory/store.js";
import type { UiEvent } from "../src/web/events.js";
import { makeHandlers, type ThreadView } from "../src/web/handlers.js";
import { readSse } from "../src/web/sse.js";
import { fakeActions } from "./helpers/actions.js";
import { buildTestGraph } from "./helpers/graph.js";
import { StreamingChatModel, toolCall } from "./helpers/models.js";

// Fase 9 (T3): las rutas de la web como funciones (Request) → Response. CA7 (seguridad), CA8 (corte) y la parte de
// servidor de CA3 (tarjeta) y CA4 (recargar).

const ORIGIN = "http://127.0.0.1:3000";
const NAMESPACE = ["test", "web-handlers"];

function post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, host: "127.0.0.1:3000", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const del = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "DELETE", headers: { "content-type": "application/json", origin: ORIGIN, host: "127.0.0.1:3000", ...headers }, body: "{}" });

async function events(response: Response): Promise<UiEvent[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
  const out: UiEvent[] = [];
  for await (const e of readSse(response.body!)) out.push(e);
  return out;
}
const lastDone = (list: UiEvent[]) => {
  const done = list.findLast((e) => e.type === "done");
  if (done?.type !== "done") throw new Error("no hubo done");
  return done.result;
};

function setup(options: { model?: AgentModel; intent?: Parameters<typeof buildTestGraph>[0]["intent"]; actions?: ReturnType<typeof fakeActions> } = {}) {
  const store = new InMemoryStore();
  const graph = buildTestGraph({
    model: options.model ?? new StreamingChatModel([new AIMessage("Hola, ¿en qué te ayudo?")]),
    tools: [],
    intent: options.intent ?? "chat",
    actions: options.actions?.runner,
    checkpointer: new MemorySaver(),
    store,
    memoryNamespace: NAMESPACE,
  });
  const log = vi.fn();
  const handlers = makeHandlers({ graph, listThreads: async () => [], memory: { store, namespace: NAMESPACE }, log });
  return { graph, handlers, log, store };
}

describe("un mensaje en vivo", () => {
  it("POST /messages responde SSE con los eventos del turno y GET /threads/:id muestra la conversación", async () => {
    const { handlers } = setup();
    const list = await events(await handlers.postMessage(post("/api/threads/hilo-web/messages", { text: "hola" }), "hilo-web"));
    expect(list.some((e) => e.type === "token")).toBe(true);
    expect(lastDone(list).reply).toBe("Hola, ¿en qué te ayudo?");

    const view = (await (await handlers.getThread("hilo-web")).json()) as ThreadView;
    expect(view).toMatchObject({ threadId: "hilo-web", exists: true, status: "ready", running: false });
    expect(view.messages.map((m) => [m.role, m.text])).toEqual([
      ["human", "hola"],
      ["ai", "Hola, ¿en qué te ayudo?"],
    ]);
  });

  it("un hilo que no existe se puede abrir: está vacío y listo", async () => {
    const { handlers } = setup();
    expect(await (await handlers.getThread("hilo-nuevo")).json()).toMatchObject({ exists: false, status: "ready", messages: [] });
  });
});

describe("seguridad de las rutas (CA7)", () => {
  it("sin Content-Type JSON: 415; con un Origin ajeno o sin Origin: 403", async () => {
    const { handlers } = setup();
    expect((await handlers.postMessage(post("/api/threads/h/messages", { text: "x" }, { "content-type": "text/plain" }), "h")).status).toBe(415);
    expect((await handlers.postMessage(post("/api/threads/h/messages", { text: "x" }, { origin: "https://pagina-ajena.example" }), "h")).status).toBe(403);
    const noOrigin = new Request(`${ORIGIN}/api/threads/h/messages`, { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1:3000" }, body: "{}" });
    expect((await handlers.postMessage(noOrigin, "h")).status).toBe(403);
    expect((await handlers.postDecision(post("/api/threads/h/decision", { decision: "approve" }, { origin: "http://evil.localhost:3000" }), "h")).status).toBe(403);
    expect((await handlers.postContinue(post("/api/threads/h/continue", {}, { "content-type": "" }), "h")).status).toBe(415);
    expect((await handlers.deleteMemory(del("/api/memories/abc", { origin: "https://pagina-ajena.example" }), "abc")).status).toBe(403);
  });

  it("un id de hilo, un mensaje o una decisión inválidos: 400, sin tocar el grafo", async () => {
    const { handlers } = setup();
    expect((await handlers.getThread("no válido!")).status).toBe(400);
    expect((await handlers.postMessage(post("/api/threads/x/messages", { text: "hola" }), "../etc")).status).toBe(400);
    expect((await handlers.postMessage(post("/api/threads/h/messages", { text: "   " }), "h")).status).toBe(400);
    expect((await handlers.postMessage(post("/api/threads/h/messages", { text: "a".repeat(4001) }), "h")).status).toBe(400);
    expect((await handlers.postMessage(post("/api/threads/h/messages", { text: "hola", extra: 1 }), "h")).status).toBe(400);
    expect((await handlers.postMessage(post("/api/threads/h/messages", "{no es json"), "h")).status).toBe(400);
    expect((await handlers.postDecision(post("/api/threads/h/decision", { decision: "aprobá" }), "h")).status).toBe(400);
    expect((await handlers.postDecision(post("/api/threads/h/decision", { decision: "approve", force: true }), "h")).status).toBe(400);
    expect((await handlers.postMessage(post("/api/threads/h/messages", { text: "x".repeat(40_000) }), "h")).status).toBe(413);
  });

  it("un segundo turno en curso sobre el mismo hilo: 409", async () => {
    const { handlers } = setup({ model: new StreamingChatModel([new AIMessage("una respuesta que tarda en escribirse"), new AIMessage("otra")], { delayMs: 20 }) });
    const first = await handlers.postMessage(post("/api/threads/h/messages", { text: "uno" }), "h");
    const second = await handlers.postMessage(post("/api/threads/h/messages", { text: "dos" }), "h");
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toMatch(/turno en curso/);
    const list = await events(first); // el primero termina normalmente…
    expect(lastDone(list).reply).toBe("una respuesta que tarda en escribirse");
    // …y suelta el hilo.
    expect((await handlers.getThread("h").then((r) => r.json())) as ThreadView).toMatchObject({ running: false });
  });

  it("un error del sistema llega como evento sin detalles internos; el detalle queda en el registro del servidor", async () => {
    const failing: AgentModel = {
      async invoke() {
        throw new Error("connect ECONNREFUSED postgresql://copilot_reader:secreto@127.0.0.1:5432/postgres");
      },
    };
    const { handlers, log } = setup({ model: failing });
    const list = await events(await handlers.postMessage(post("/api/threads/h/messages", { text: "hola" }), "h"));
    const error = list.at(-1);
    expect(error).toMatchObject({ type: "error", pending: true });
    expect(JSON.stringify(list)).not.toMatch(/postgresql|secreto|ECONNREFUSED/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("hilo h"), expect.any(Error));
  });
});

describe("corte y «Continuar» (CA8, CA4)", () => {
  it("si el navegador corta la conexión, el turno se detiene, el hilo queda a medias y se puede continuar", async () => {
    const LONG = "Una respuesta larga, que se escribe de a poco, para cortarla a la mitad sin que termine.";
    const { handlers, graph } = setup({ model: new StreamingChatModel([new AIMessage(LONG), new AIMessage(LONG)], { delayMs: 15 }) });
    const response = await handlers.postMessage(post("/api/threads/h/messages", { text: "contame" }), "h");
    const reader = response.body!.getReader();
    await reader.read(); // llegó algo
    await reader.cancel(); // la persona recargó la página
    await vi.waitFor(async () => expect((await getStatus(graph, "h")).pending).toBe(true));

    const view = (await (await handlers.getThread("h")).json()) as ThreadView;
    expect(view).toMatchObject({ status: "pending", running: false });
    // Con el hilo a medias no se acepta un mensaje nuevo…
    expect((await handlers.postMessage(post("/api/threads/h/messages", { text: "otra cosa" }), "h")).status).toBe(409);
    // …pero sí «Continuar», que termina el turno sin duplicar nada.
    const list = await events(await handlers.postContinue(post("/api/threads/h/continue"), "h"));
    expect(lastDone(list).reply).toBe(LONG);
    const after = (await (await handlers.getThread("h")).json()) as ThreadView;
    expect(after.status).toBe("ready");
    expect(after.messages.map((m) => m.role)).toEqual(["human", "ai"]);
    // Continuar un hilo que no está a medias: 409.
    expect((await handlers.postContinue(post("/api/threads/h/continue"), "h")).status).toBe(409);
  });
});

describe("la tarjeta desde la web (CA3, CA4)", () => {
  const propose = (actions: ReturnType<typeof fakeActions>, ...replies: string[]) =>
    setup({
      intent: "action",
      actions,
      model: new StreamingChatModel([toolCall("a1", "adjustStock", { sku: "CER-001", delta: 5, reason: "reposición" }), ...replies.map((r) => new AIMessage(r))]),
    });

  it("la pausa se ve al recargar; con una tarjeta no se puede escribir; aprobar reanuda y ejecuta", async () => {
    const actions = fakeActions();
    const { handlers } = propose(actions, "Listo: sumé 5.");
    const paused = await events(await handlers.postMessage(post("/api/threads/h/messages", { text: "sumá 5 ceras" }), "h"));
    expect(paused.filter((e) => e.type === "approval")).toHaveLength(1);
    expect(lastDone(paused).awaiting?.action.tool).toBe("adjustStock");

    // Recargar: la misma tarjeta, desde el hilo guardado.
    const view = (await (await handlers.getThread("h")).json()) as ThreadView;
    expect(view.status).toBe("awaiting");
    expect(view.awaiting?.action.params).toEqual({ sku: "CER-001", delta: 5, reason: "reposición" });

    expect((await handlers.postMessage(post("/api/threads/h/messages", { text: "y otra cosa" }), "h")).status).toBe(409);

    const approved = await events(await handlers.postDecision(post("/api/threads/h/decision", { decision: "approve" }), "h"));
    expect(approved.find((e) => e.type === "action_result")).toMatchObject({ ok: true, tool: "adjustStock" });
    expect(lastDone(approved).reply).toBe("Listo: sumé 5.");
    expect(actions.executed).toHaveLength(1);
    // Ya no hay nada que decidir.
    expect((await handlers.postDecision(post("/api/threads/h/decision", { decision: "approve" }), "h")).status).toBe(409);
  });

  it("editar no ejecuta: vuelve la tarjeta recalculada; una edición inválida trae el motivo y la acción sigue pendiente", async () => {
    const actions = fakeActions();
    const { handlers } = propose(actions, "Hecho.");
    await events(await handlers.postMessage(post("/api/threads/h/messages", { text: "sumá 5 ceras" }), "h"));

    const edited = await events(await handlers.postDecision(post("/api/threads/h/decision", { decision: "edit", params: { sku: "CER-001", delta: 8, reason: "reposición" } }), "h"));
    expect(edited.find((e) => e.type === "approval")).toMatchObject({ request: { edited: true, action: { params: { delta: 8 } } } });
    expect(actions.executed).toHaveLength(0);

    const invalid = await events(await handlers.postDecision(post("/api/threads/h/decision", { decision: "edit", params: { sku: "INVALIDO", delta: 8, reason: "x" } }), "h"));
    const card = invalid.find((e) => e.type === "approval");
    expect(card).toMatchObject({ request: { action: { params: { delta: 8 } } } });
    expect(card?.type === "approval" && card.request.error).toBeTruthy();
    expect(actions.executed).toHaveLength(0);

    const rejected = await events(await handlers.postDecision(post("/api/threads/h/decision", { decision: "reject", comment: "mejor otro día" }), "h"));
    expect(rejected.find((e) => e.type === "action_result")).toMatchObject({ ok: true, message: expect.stringMatching(/rechazó/) });
    expect(actions.executed).toEqual([expect.objectContaining({ decision: "rejected" })]);
  });

  it("dos decisiones a la vez sobre el mismo hilo: una corre y la otra recibe 409; la acción se ejecuta una sola vez", async () => {
    const actions = fakeActions();
    const { handlers } = propose(actions, "Hecho.");
    await events(await handlers.postMessage(post("/api/threads/h/messages", { text: "sumá 5 ceras" }), "h"));
    const [a, b] = await Promise.all([
      handlers.postDecision(post("/api/threads/h/decision", { decision: "approve" }), "h"),
      handlers.postDecision(post("/api/threads/h/decision", { decision: "approve" }), "h"),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    await events(a.status === 200 ? a : b);
    expect(actions.executed).toHaveLength(1);
  });
});

describe("memorias (R14)", () => {
  it("lista y borra de a una; borrar una que no existe da 404", async () => {
    const { handlers, store } = setup();
    const bank = { store, namespace: NAMESPACE };
    const kept = await saveMemory(bank, { kind: "rule", text: "Los lunes no se agendan turnos." });
    const gone = await saveMemory(bank, { kind: "preference", text: "Decí los montos con la palabra pesos." });

    const listed = (await (await handlers.listMemories()).json()) as { memories: { id: string }[] };
    expect(listed.memories.map((m) => m.id).sort()).toEqual([kept.id, gone.id].sort());

    const deleted = await handlers.deleteMemory(del(`/api/memories/${gone.id}`), gone.id);
    expect(deleted.status).toBe(200);
    expect(((await (await handlers.listMemories()).json()) as { memories: { id: string }[] }).memories.map((m) => m.id)).toEqual([kept.id]);
    expect((await handlers.deleteMemory(del(`/api/memories/${gone.id}`), gone.id)).status).toBe(404);
    expect((await handlers.deleteMemory(del("/api/memories/x y"), "x y")).status).toBe(400);
  });
});
