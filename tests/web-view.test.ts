import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../src/graph/approval.js";
import type { TurnResult } from "../src/graph/run-turn.js";
import type { UiEvent } from "../src/web/events.js";
import type { ThreadView } from "../src/web/handlers.js";
import { applyEvent, connectionLost, fromThreadView, startContinuation, startMessage, type PageState } from "../src/web/turn-view.js";

// Fase 9 (T4): el reductor de la página. Decide qué se ve; los componentes solo lo dibujan.

const view = (over: Partial<ThreadView> = {}): ThreadView => ({ threadId: "h", exists: true, status: "ready", running: false, next: [], messages: [], ...over });
const result = (over: Partial<TurnResult> = {}): TurnResult => ({
  reply: "",
  route: {},
  summary: { modelCalls: 1, toolCalls: [], actions: [], failedTools: [], inputTokens: 100, outputTokens: 10, usage: [{ model: "claude-haiku-5-5", calls: 1, inputTokens: 100, outputTokens: 10 }] },
  agents: [],
  coordination: [],
  memoryCount: 0,
  ...over,
});
const card: ApprovalRequest = { kind: "approve_action", action: { id: "h:a1", toolCallId: "a1", tool: "adjustStock", params: { sku: "CER-001", delta: 5 }, risk: "medium", summary: "Sumar 5 a Cera" } };
const run = (state: PageState, events: UiEvent[]) => events.reduce(applyEvent, state);
const turnOf = (state: PageState) => {
  const turn = state.items.findLast((i) => i.kind === "turn");
  if (turn?.kind !== "turn") throw new Error("no hay turno");
  return turn;
};

describe("abrir o recargar la página", () => {
  it("arma la conversación del hilo guardado, con la tarjeta si la hay", () => {
    const state = fromThreadView(
      view({
        status: "awaiting",
        awaiting: card,
        messages: [
          { id: "1", role: "human", kind: "message", text: "sumá 5 ceras" },
          { id: "2", role: "ai", kind: "step", text: "Voy a buscar la cera." },
        ],
      }),
    );
    expect(state.status).toBe("awaiting");
    expect(state.awaiting).toBe(card);
    expect(state.items).toEqual([
      { kind: "human", id: "1", text: "sumá 5 ceras" },
      { kind: "history", id: "2", text: "Voy a buscar la cera.", step: true },
    ]);
  });
});

describe("un turno en vivo", () => {
  it("los tokens arman un borrador que el mensaje final reemplaza; las herramientas cambian de estado", () => {
    let state = startMessage(fromThreadView(view()), "¿stock de cera?");
    expect(state.status).toBe("running");
    expect(state.items.map((i) => i.kind)).toEqual(["human", "turn"]);

    state = run(state, [
      { type: "route", tasks: [{ intent: "query", request: "¿stock de cera?" }] },
      { type: "agent", agent: "query_graph", status: "start" },
      { type: "tool_start", id: "c1", agent: "query_graph", name: "getStockLevels", args: {} },
    ]);
    expect(turnOf(state).parts.find((p) => p.type === "tool")).toMatchObject({ status: "running" });

    state = run(state, [
      { type: "tool_end", id: "c1", name: "getStockLevels", ok: true },
      { type: "token", messageId: "m1", agent: "query_graph", text: "Quedan " },
      { type: "token", messageId: "m1", agent: "query_graph", text: "31" },
    ]);
    expect(turnOf(state).parts.find((p) => p.type === "text")).toMatchObject({ text: "Quedan 31", streaming: true, kind: "reply" });

    state = run(state, [
      { type: "message", id: "m1", author: "query_graph", kind: "reply", text: "Quedan 31 unidades." },
      { type: "agent", agent: "query_graph", status: "end" },
      { type: "done", result: result({ reply: "Quedan 31 unidades." }) },
    ]);
    const turn = turnOf(state);
    expect(turn.running).toBe(false);
    expect(turn.parts.filter((p) => p.type === "text")).toEqual([{ type: "text", id: "m1", author: "query_graph", kind: "reply", text: "Quedan 31 unidades.", streaming: false }]);
    expect(turn.parts.find((p) => p.type === "tool")).toMatchObject({ status: "done" });
    expect(turn.parts.find((p) => p.type === "agent")).toMatchObject({ status: "done" });
    expect(state.status).toBe("ready");
    expect(state.session).toEqual([{ model: "claude-haiku-5-5", calls: 1, inputTokens: 100, outputTokens: 10 }]);
  });

  it("un borrador que termina siendo el texto de una herramienta pasa a ser un paso", () => {
    const state = run(startMessage(fromThreadView(view()), "x"), [
      { type: "token", messageId: "s1", agent: "query_graph", text: "Voy a mirar" },
      { type: "message", id: "s1", author: "query_graph", kind: "step", text: "Voy a mirar el stock." },
    ]);
    expect(turnOf(state).parts).toEqual([{ type: "text", id: "s1", author: "query_graph", kind: "step", text: "Voy a mirar el stock.", streaming: false }]);
  });

  it("la sesión suma el uso de cada turno", () => {
    let state = run(startMessage(fromThreadView(view()), "a"), [{ type: "done", result: result() }]);
    state = run(startMessage(state, "b"), [{ type: "done", result: result() }]);
    expect(state.session).toEqual([{ model: "claude-haiku-5-5", calls: 2, inputTokens: 200, outputTokens: 20 }]);
  });
});

describe("la tarjeta y «Continuar»", () => {
  it("approval deja la página esperando; decidir sigue el MISMO turno con lo que decidió la persona", () => {
    let state = run(startMessage(fromThreadView(view()), "sumá 5 ceras"), [
      { type: "approval", request: card },
      { type: "done", result: result({ awaiting: card }) },
    ]);
    expect(state.status).toBe("awaiting");
    expect(state.awaiting).toBe(card);

    state = startContinuation(state, { decision: "reject", comment: "mejor otro día" });
    expect(state.status).toBe("running");
    expect(state.awaiting).toBeUndefined();
    expect(state.items.filter((i) => i.kind === "turn")).toHaveLength(1);
    expect(turnOf(state).parts.at(-1)).toEqual({ type: "decision", text: "Rechazaste la acción: «mejor otro día»." });

    state = run(state, [
      { type: "action_result", tool: "adjustStock", ok: true, message: "La persona rechazó la acción." },
      { type: "done", result: result() },
    ]);
    expect(state.status).toBe("ready");
    expect(turnOf(state).parts.some((p) => p.type === "action")).toBe(true);
  });

  it("una edición vuelve a mostrar la tarjeta (recalculada)", () => {
    const edited: ApprovalRequest = { ...card, edited: true, action: { ...card.action, params: { sku: "CER-001", delta: 8 } } };
    let state = run(startMessage(fromThreadView(view()), "x"), [{ type: "approval", request: card }, { type: "done", result: result({ awaiting: card }) }]);
    state = run(startContinuation(state, { decision: "edit", params: { sku: "CER-001", delta: 8 } }), [{ type: "approval", request: edited }, { type: "done", result: result({ awaiting: edited }) }]);
    expect(state.status).toBe("awaiting");
    expect(state.awaiting).toBe(edited);
  });

  it("un error deja el turno a medias si el servidor lo dice; «Continuar» sigue el mismo turno", () => {
    let state = run(startMessage(fromThreadView(view()), "x"), [
      { type: "agent", agent: "query_graph", status: "start" },
      { type: "tool_start", id: "c1", agent: "query_graph", name: "listAppointments", args: {} },
      { type: "error", message: "No se pudo completar el pedido.", pending: true },
    ]);
    expect(state.status).toBe("pending");
    expect(turnOf(state)).toMatchObject({ running: false, error: "No se pudo completar el pedido." });
    expect(turnOf(state).parts.find((p) => p.type === "tool")).toMatchObject({ status: "error" });

    state = startContinuation(state);
    expect(state.status).toBe("running");
    expect(turnOf(state).error).toBeUndefined();
  });

  it("al abrir un hilo a medias, «Continuar» empieza un turno nuevo", () => {
    const state = startContinuation(fromThreadView(view({ status: "pending", messages: [{ id: "1", role: "human", kind: "message", text: "x" }] })));
    expect(state.items.map((i) => i.kind)).toEqual(["human", "turn"]);
  });

  it("si la conexión se corta sin done ni error, el turno queda a medias", () => {
    const state = connectionLost(startMessage(fromThreadView(view()), "x"));
    expect(state.status).toBe("pending");
    expect(turnOf(state).error).toMatch(/Se cortó la conexión/);
    // Si no había nada corriendo, no cambia nada.
    const idle = fromThreadView(view());
    expect(connectionLost(idle)).toBe(idle);
  });
});
