import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { BranchIncompleteError, BranchNotFoundError, listBranches, switchBranch } from "../src/graph/branches.js";
import { readHistory } from "../src/graph/history.js";
import { resumeTurn, streamRunTurn, ThreadAwaitingApprovalError } from "../src/graph/run-turn.js";
import { getStatus } from "../src/graph/threads.js";
import { streamForkTurn, streamReplayTurn } from "../src/graph/time-travel.js";
import type { UiEvent } from "../src/web/events.js";
import { fakeActions } from "./helpers/actions.js";
import { buildTestGraph } from "./helpers/graph.js";
import { scriptedModel, toolCall } from "./helpers/models.js";

// Las ramas del hilo (specs/ramas-del-hilo.md, T2: CA1 y CA2 sin modelo real).

async function all(events: AsyncIterable<UiEvent>) {
  const out: UiEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** Charla que contesta "eco N: <mensaje>" y guarda lo que recibió el modelo en cada llamada. */
function echoGraph() {
  const { model, calls } = scriptedModel((n, msgs) => new AIMessage(`eco ${n + 1}: ${msgs.findLast((m) => m.type === "human")?.text}`));
  const graph = buildTestGraph({ model, tools: [], intent: "chat", checkpointer: new MemorySaver() });
  return { graph, calls };
}
type Graph = ReturnType<typeof echoGraph>["graph"];

async function say(graph: Graph, text: string, id = "h") {
  const turn = (await all(streamRunTurn({ graph }, id, text)))[0];
  if (turn?.type !== "turn") throw new Error("el primer evento no es turn");
  return turn.humanMessageId;
}
const edit = (graph: Graph, messageId: string, text: string) => all(streamForkTurn({ graph }, "h", messageId, text));
const texts = async (graph: Graph) => (await getStatus(graph, "h")).messages.map((m) => m.text);
const summary = async (graph: Graph) =>
  (await listBranches(graph, "h")).branches.map((b) => ({ version: b.version, label: b.label, current: b.current, messageCount: b.messageCount }));
const tipOf = async (graph: Graph, version: number) => (await listBranches(graph, "h")).branches.find((b) => b.version === version)!.tipId;

describe("listBranches (CA1)", () => {
  it("un hilo que no existe no tiene ramas; uno sin bifurcaciones, una", async () => {
    const { graph } = echoGraph();
    expect((await listBranches(graph, "h")).branches).toEqual([]);
    await say(graph, "hola");
    await say(graph, "¿y mañana?");
    expect(await summary(graph)).toEqual([{ version: 1, label: "hola", current: true, messageCount: 4 }]);
  });

  it("editar el primer mensaje: dos ramas, numeradas por orden de creación", async () => {
    const { graph } = echoGraph();
    const first = await say(graph, "hola");
    await edit(graph, first, "buenas");
    expect(await summary(graph)).toEqual([
      { version: 1, label: "hola", current: false, messageCount: 2 },
      { version: 2, label: "buenas", current: true, messageCount: 2 },
    ]);
    const [v1, v2] = (await listBranches(graph, "h")).branches;
    expect(v1!.forkFromId).toBeUndefined();
    expect(v2!.forkFromId).toBeDefined();
    expect(v1!.complete && v2!.complete).toBe(true);
  });

  it("editar un mensaje del medio: la parte común no cuenta como rama; cada una se nombra por donde se separa", async () => {
    const { graph } = echoGraph();
    await say(graph, "uno");
    const second = await say(graph, "dos");
    await say(graph, "tres");
    await edit(graph, second, "DOS");
    expect(await summary(graph)).toEqual([
      { version: 1, label: "dos", current: false, messageCount: 6 },
      { version: 2, label: "DOS", current: true, messageCount: 4 },
    ]);
    // Las dos salen del mismo checkpoint: el de antes de «dos», que ya tenía «uno» y su respuesta.
    const history = await readHistory(graph, "h");
    const v2 = (await listBranches(graph, "h")).branches[1]!;
    expect(history.byId.get(v2.forkFromId!)!.values.messages!.map((m) => m.text)).toEqual(["uno", "eco 1: uno"]);
  });

  it("reintentar dos veces: tres versiones con el mismo mensaje y números distintos", async () => {
    const { graph } = echoGraph();
    const first = await say(graph, "hola");
    await all(streamReplayTurn({ graph }, "h", first));
    const again = (await getStatus(graph, "h")).messages[0]!.id!;
    await all(streamReplayTurn({ graph }, "h", again));
    const tree = await summary(graph);
    expect(tree.map((b) => b.label)).toEqual(["hola", "hola", "hola"]);
    expect(tree.map((b) => b.version)).toEqual([1, 2, 3]);
    expect(tree.map((b) => b.current)).toEqual([false, false, true]);
  });

  it("una punta incompleta se marca y no se puede abrir", async () => {
    const { graph } = echoGraph();
    const first = await say(graph, "hola");
    const done = await tipOf(graph, 1);
    // Una rama que nunca corrió (como un corte justo después de bifurcar): queda en `load_memory`.
    const input = [...(await readHistory(graph, "h")).byId.values()].find((s) => s.next.includes("__start__"))!;
    await graph.updateState(input.config, { messages: [new HumanMessage({ content: "buenas", id: "x" })] }, "__start__");
    expect(first).toBeDefined();
    await graph.updateState({ configurable: { thread_id: "h", checkpoint_id: done, checkpoint_ns: "" } }, null); // volver a la 1 a mano
    const tree = (await listBranches(graph, "h")).branches;
    expect(tree.map((b) => [b.version, b.complete])).toEqual([
      [1, true],
      [2, false],
    ]);
    await expect(switchBranch(graph, "h", tree[1]!.tipId)).rejects.toBeInstanceOf(BranchIncompleteError);
  });
});

describe("switchBranch (CA2)", () => {
  it("abrir la original deja sus mensajes, sin llamar al modelo; el turno siguiente sigue desde ahí", async () => {
    const { graph, calls } = echoGraph();
    const first = await say(graph, "hola");
    await edit(graph, first, "buenas");
    const before = calls.length;

    const result = await switchBranch(graph, "h", await tipOf(graph, 1));
    expect(result).toEqual({ version: 1, unchanged: false, leftActions: [] });
    expect(calls.length, "abrir una rama no llama al modelo").toBe(before);
    expect(await texts(graph)).toEqual(["hola", "eco 1: hola"]);
    expect(await summary(graph)).toEqual([
      { version: 1, label: "hola", current: true, messageCount: 2 },
      { version: 2, label: "buenas", current: false, messageCount: 2 },
    ]);

    await say(graph, "chau");
    expect(calls.at(-1)!.filter((m) => m.type === "human").map((m) => m.text), "el modelo ve solo la rama abierta").toEqual(["hola", "chau"]);
    expect(await texts(graph)).toEqual(["hola", "eco 1: hola", "chau", "eco 3: chau"]);
    expect((await summary(graph)).map((b) => [b.version, b.label, b.current, b.messageCount])).toEqual([
      [1, "hola", true, 4],
      [2, "buenas", false, 2],
    ]);
  });

  it("ir y volver (1 → 2 → 1): siempre las mismas dos ramas, con los mismos números", async () => {
    const { graph } = echoGraph();
    const first = await say(graph, "hola");
    await edit(graph, first, "buenas");
    await switchBranch(graph, "h", await tipOf(graph, 1));
    await switchBranch(graph, "h", await tipOf(graph, 2));
    expect(await texts(graph)).toEqual(["buenas", "eco 2: buenas"]);
    await switchBranch(graph, "h", await tipOf(graph, 1));
    expect(await summary(graph)).toEqual([
      { version: 1, label: "hola", current: true, messageCount: 2 },
      { version: 2, label: "buenas", current: false, messageCount: 2 },
    ]);
    // Después de abrir otra, se puede editar en la abierta y nace la 3.
    await edit(graph, (await getStatus(graph, "h")).messages[0]!.id!, "qué tal");
    expect((await summary(graph)).map((b) => [b.version, b.label, b.current])).toEqual([
      [1, "hola", false],
      [2, "buenas", false],
      [3, "qué tal", true],
    ]);
  });

  it("abrir la actual no hace nada; un id que no es una punta de este hilo, BranchNotFoundError", async () => {
    const { graph } = echoGraph();
    const first = await say(graph, "hola");
    await say(graph, "otro hilo", "otro");
    expect(await switchBranch(graph, "h", await tipOf(graph, 1))).toEqual({ version: 1, unchanged: true, leftActions: [] });
    const history = await readHistory(graph, "h");
    const notATip = [...history.byId.keys()].find((id) => history.children.get(id)?.length)!;
    await expect(switchBranch(graph, "h", notATip)).rejects.toBeInstanceOf(BranchNotFoundError);
    const otherTip = (await listBranches(graph, "otro")).branches[0]!.tipId;
    await expect(switchBranch(graph, "h", otherTip)).rejects.toBeInstanceOf(BranchNotFoundError);
    expect(first).toBeDefined();
  });
});

describe("con acciones (R7)", () => {
  /** «sumá 5» → tarjeta → aprobar (se ejecuta); reintentar → tarjeta nueva → rechazar. */
  async function executedThenRetried() {
    const actions = fakeActions();
    const model = scriptedModel([
      toolCall("a1", "adjustStock", { sku: "CER-001", delta: 5, reason: "pedido" }),
      new AIMessage("Listo: sumé 5."),
      toolCall("a2", "adjustStock", { sku: "CER-001", delta: 5, reason: "pedido" }),
      new AIMessage("No lo hice."),
    ]);
    const graph = buildTestGraph({ model: model.model, tools: [], intent: "action", actions: actions.runner, checkpointer: new MemorySaver() });
    const turn = (await all(streamRunTurn({ graph }, "h", "sumá 5")))[0];
    if (turn?.type !== "turn") throw new Error("sin turn");
    await resumeTurn({ graph }, "h", { decision: "approve" });
    await all(streamReplayTurn({ graph }, "h", turn.humanMessageId));
    return { graph, actions, model };
  }

  it("la versión que ejecutó una acción se marca mientras no es la actual; dejarla lo avisa", async () => {
    const { graph, actions } = await executedThenRetried();
    // Con la tarjeta nueva pendiente no se puede abrir otra versión.
    await expect(switchBranch(graph, "h", (await listBranches(graph, "h")).branches[0]!.tipId)).rejects.toBeInstanceOf(ThreadAwaitingApprovalError);
    await resumeTurn({ graph }, "h", { decision: "reject" });

    let tree = (await listBranches(graph, "h")).branches;
    expect(tree.map((b) => [b.version, b.label, b.current, b.executedActions.length])).toEqual([
      [1, "sumá 5", false, 1],
      [2, "sumá 5", true, 0],
    ]);
    const executions = actions.executed.length;

    const opened = await switchBranch(graph, "h", tree[0]!.tipId);
    expect(opened.leftActions, "la 2 no ejecutó nada").toEqual([]);
    tree = (await listBranches(graph, "h")).branches;
    expect(tree.map((b) => b.executedActions.length), "desde la 1, la acción ya está en la actual").toEqual([0, 0]);

    const back = await switchBranch(graph, "h", tree[1]!.tipId);
    expect(back.leftActions, "dejar la 1 avisa lo que ejecutó").toHaveLength(1);
    expect(actions.executed.length, "ir y volver no ejecuta nada").toBe(executions);
  });
});
