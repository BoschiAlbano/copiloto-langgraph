import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import type { BranchTree } from "../src/graph/branches.js";
import { readHistory } from "../src/graph/history.js";
import { streamRunTurn } from "../src/graph/run-turn.js";
import { getStatus } from "../src/graph/threads.js";
import { streamForkTurn } from "../src/graph/time-travel.js";
import type { UiEvent } from "../src/web/events.js";
import { makeHandlers, type BranchSwitchView } from "../src/web/handlers.js";
import { fakeActions } from "./helpers/actions.js";
import { buildTestGraph } from "./helpers/graph.js";
import { scriptedModel, StreamingChatModel, toolCall } from "./helpers/models.js";

// Las ramas del hilo (specs/ramas-del-hilo.md, T3: CA3). Las rutas GET /branches y POST /branch.

const ORIGIN = "http://127.0.0.1:3000";
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, host: "127.0.0.1:3000", ...headers }, body: JSON.stringify(body) });

async function all(events: AsyncIterable<UiEvent>) {
  const out: UiEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** Un hilo con dos ramas: «hola» (la 1) y «buenas» (la 2, actual). */
async function twoBranches(model = scriptedModel((n, msgs) => new AIMessage(`eco ${n + 1}: ${msgs.findLast((m) => m.type === "human")?.text}`)).model) {
  const graph = buildTestGraph({ model, tools: [], intent: "chat", checkpointer: new MemorySaver() });
  const turn = (await all(streamRunTurn({ graph }, "h", "hola")))[0];
  if (turn?.type !== "turn") throw new Error("sin turn");
  await all(streamForkTurn({ graph }, "h", turn.humanMessageId, "buenas"));
  const handlers = makeHandlers({ graph, listThreads: async () => [], log: vi.fn() });
  const tree = async () => (await (await handlers.getBranches("h")).json()) as BranchTree;
  return { graph, handlers, tree };
}

describe("GET /api/threads/:id/branches", () => {
  it("devuelve las versiones; un hilo nuevo no tiene; un id inválido da 400", async () => {
    const { handlers, tree } = await twoBranches();
    const { branches } = await tree();
    expect(branches.map((b) => [b.version, b.label, b.current])).toEqual([
      [1, "hola", false],
      [2, "buenas", true],
    ]);
    expect(((await (await handlers.getBranches("nuevo")).json()) as BranchTree).branches).toEqual([]);
    expect((await handlers.getBranches("../x")).status).toBe(400);
  });
});

describe("POST /api/threads/:id/branch (CA3)", () => {
  it("abre la versión pedida y responde con el hilo como queda", async () => {
    const { handlers, tree } = await twoBranches();
    const v1 = (await tree()).branches[0]!;
    const response = await handlers.postBranch(post("/api/threads/h/branch", { checkpointId: v1.tipId }), "h");
    expect(response.status).toBe(200);
    const view = (await response.json()) as BranchSwitchView;
    expect(view).toMatchObject({ version: 1, unchanged: false, leftActions: [] });
    expect(view.thread).toMatchObject({ status: "ready", running: false });
    expect(view.thread.messages.map((m) => m.text)).toEqual(["hola", "eco 1: hola"]);
    expect((await tree()).branches.map((b) => b.current)).toEqual([true, false]);
  });

  it("los controles de siempre: origen ajeno 403, cuerpo inválido 400, algo que no es una punta 404", async () => {
    const { graph, handlers, tree } = await twoBranches();
    const v1 = (await tree()).branches[0]!;
    expect((await handlers.postBranch(post("/api/threads/h/branch", { checkpointId: v1.tipId }, { origin: "https://ajena.example" }), "h")).status).toBe(403);
    expect((await handlers.postBranch(post("/api/threads/h/branch", { checkpointId: v1.tipId, extra: 1 }), "h")).status).toBe(400);
    expect((await handlers.postBranch(post("/api/threads/h/branch", { checkpointId: "no/vale" }), "h")).status).toBe(400);
    expect((await handlers.postBranch(post("/api/threads/h/branch", { checkpointId: v1.tipId }), "../x")).status).toBe(400);
    const history = await readHistory(graph, "h");
    const notATip = [...history.byId.keys()].find((id) => history.children.get(id)?.length)!;
    expect((await handlers.postBranch(post("/api/threads/h/branch", { checkpointId: notATip }), "h")).status).toBe(404);
    expect((await handlers.postBranch(post("/api/threads/h/branch", { checkpointId: "1f0a0000-0000-6000-8000-000000000000" }), "h")).status).toBe(404);
  });

  it("una versión incompleta: 409", async () => {
    const { graph, handlers, tree } = await twoBranches();
    // Una rama que nunca corrió, y volver a la 2 a mano: la nueva queda como punta incompleta.
    const v2 = (await tree()).branches[1]!;
    const input = [...(await readHistory(graph, "h")).byId.values()].find((s) => s.next.includes("__start__"))!;
    await graph.updateState(input.config, { messages: [new HumanMessage({ content: "otra", id: "x" })] }, "__start__");
    await graph.updateState({ configurable: { thread_id: "h", checkpoint_id: v2.tipId, checkpoint_ns: "" } }, null);
    const incomplete = (await tree()).branches.find((b) => !b.complete)!;
    const response = await handlers.postBranch(post("/api/threads/h/branch", { checkpointId: incomplete.tipId }), "h");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/incompleta/);
  });

  it("con una tarjeta pendiente: 409", async () => {
    const actions = fakeActions();
    const model = scriptedModel([new AIMessage("hola"), toolCall("a1", "adjustStock", { sku: "CER-001", delta: 5, reason: "pedido" })]);
    const graph = buildTestGraph({ model: model.model, tools: [], intent: ["chat", "action"], actions: actions.runner, checkpointer: new MemorySaver() });
    const turn = (await all(streamRunTurn({ graph }, "h", "hola")))[0];
    if (turn?.type !== "turn") throw new Error("sin turn");
    await all(streamForkTurn({ graph }, "h", turn.humanMessageId, "sumá 5"));
    expect((await getStatus(graph, "h")).awaiting).toBeDefined();
    const handlers = makeHandlers({ graph, listThreads: async () => [], log: vi.fn() });
    const v1 = ((await (await handlers.getBranches("h")).json()) as BranchTree).branches[0]!;
    const response = await handlers.postBranch(post("/api/threads/h/branch", { checkpointId: v1.tipId }), "h");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/decisión/);
  });

  it("con un turno en curso: 409; con un turno a medias: 409", async () => {
    const LONG = "Una respuesta larga, que se escribe de a poco, para cortarla a la mitad sin que termine.";
    const { graph, handlers, tree } = await twoBranches(new StreamingChatModel([new AIMessage("uno"), new AIMessage("dos"), new AIMessage(LONG)], { delayMs: 15 }) as never);
    const v1 = (await tree()).branches[0]!;
    const running = await handlers.postMessage(post("/api/threads/h/messages", { text: "contame" }), "h");
    expect((await handlers.postBranch(post("/api/threads/h/branch", { checkpointId: v1.tipId }), "h")).status).toBe(409);
    // Cortar ese turno con el primer token: queda a medias.
    const reader = running.body!.getReader();
    const decoder = new TextDecoder();
    for (let seen = ""; !seen.includes(`"type":"token"`); ) seen += decoder.decode((await reader.read()).value);
    await reader.cancel();
    await vi.waitFor(async () => expect((await getStatus(graph, "h")).pending).toBe(true));
    await vi.waitFor(async () => expect((await (await handlers.getThread("h")).json()) as { running: boolean }).toMatchObject({ running: false }));
    const response = await handlers.postBranch(post("/api/threads/h/branch", { checkpointId: v1.tipId }), "h");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/a medias/);
  });
});
