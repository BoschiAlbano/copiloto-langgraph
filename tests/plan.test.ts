import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import type { Intent } from "../src/graph/intents.js";
import { agentInput, normalizePlan, PLAN_FALLBACK_REASON, secondActionNotice, sharedTask, type Plan, type Task } from "../src/graph/plan.js";

// CA5: las reglas de R5 son código, no decisiones del modelo.

const LAST = "el mensaje completo de la persona";
const out = (...tasks: [Intent, string][]) => ({ reason: "motivo", tasks: tasks.map(([intent, request]) => ({ intent, request })) });
const shape = (plan: Plan) => plan.tasks.map((t) => `${t.intent}:${t.request}`);

describe("normalizePlan", () => {
  it("una tarea sola queda igual, pendiente y con id 1", () => {
    const n = normalizePlan(out(["report", "resumen de la semana"]), LAST);
    expect(n).toEqual({
      plan: { tasks: [{ id: "1", intent: "report", request: "resumen de la semana", status: "pending" }] },
      intent: "report",
      reason: "motivo",
      fallback: false,
    });
  });

  it("acción y consulta: en ese orden", () => {
    expect(shape(normalizePlan(out(["action", "registrá la venta"], ["query", "stock del gel"]), LAST).plan)).toEqual([
      "action:registrá la venta",
      "query:stock del gel",
    ]);
  });

  it("la acción va primero aunque se pida después, y el resto conserva su orden", () => {
    const n = normalizePlan(out(["query", "stock del gel"], ["report", "resumen del mes"], ["action", "registrá la venta"]), LAST);
    expect(shape(n.plan)).toEqual(["action:registrá la venta", "query:stock del gel", "report:resumen del mes"]);
    expect(n.plan.tasks.map((t) => t.id)).toEqual(["1", "2", "3"]);
    expect(n.intent).toBe("action");
  });

  it("una sola acción por mensaje: se hace la primera y el plan avisa de la otra", () => {
    const n = normalizePlan(out(["action", "agendá a Bruno"], ["action", "cancelá lo de Damián"], ["query", "turnos de mañana"]), LAST);
    expect(shape(n.plan)).toEqual(["action:agendá a Bruno", "query:turnos de mañana"]);
    expect(n.plan.notice).toBe(secondActionNotice("cancelá lo de Damián"));
    expect(n.plan.notice).toContain("una sola acción por mensaje");
  });

  it("sin una segunda acción no hay aviso", () => {
    expect(normalizePlan(out(["action", "x"], ["query", "y"]), LAST).plan.notice).toBeUndefined();
  });

  it("una tarea unclear anula todas: se pide aclaración sobre el mensaje completo", () => {
    const n = normalizePlan(out(["action", "registrá la venta"], ["unclear", "lo otro"]), LAST);
    expect(shape(n.plan)).toEqual([`unclear:${LAST}`]);
    expect(n.intent).toBe("unclear");
  });

  it("la charla con otras tareas se descarta; sola, queda", () => {
    expect(shape(normalizePlan(out(["chat", "gracias"], ["query", "ventas de ayer"]), LAST).plan)).toEqual(["query:ventas de ayer"]);
    expect(shape(normalizePlan(out(["chat", "hola"], ["chat", "gracias"]), LAST).plan)).toEqual([`chat:${LAST}`]);
  });

  it("las consultas seguidas se unen en una sola tarea", () => {
    const n = normalizePlan(out(["query", "turnos de mañana?"], ["query", "ventas de hoy?"]), LAST);
    expect(shape(n.plan)).toEqual(["query:turnos de mañana? ventas de hoy?"]);
  });

  it("se unen también las que quedan juntas al poner la acción primero", () => {
    const n = normalizePlan(out(["query", "a?"], ["action", "hacé b"], ["query", "c?"]), LAST);
    expect(shape(n.plan)).toEqual(["action:hacé b", "query:a? c?"]);
  });

  it("consultas separadas por un reporte no se unen", () => {
    expect(shape(normalizePlan(out(["query", "a?"], ["report", "r"], ["query", "c?"]), LAST).plan)).toEqual(["query:a?", "report:r", "query:c?"]);
  });

  describe("salida inválida: una consulta con el mensaje completo", () => {
    const invalid: [string, unknown][] = [
      ["nada", undefined],
      ["null", null],
      ["sin tareas", { reason: "x", tasks: [] }],
      ["demasiadas tareas", out(["query", "a"], ["query", "b"], ["query", "c"], ["query", "d"])],
      ["intención inventada", out(["borrar" as Intent, "todo"])],
      ["pedido vacío", out(["query", ""])],
      ["formato de la fase 3", { reason: "x", intent: "query" }],
      ["sin motivo", { tasks: [{ intent: "query", request: "a" }] }],
    ];
    for (const [label, output] of invalid) {
      it(label, () => {
        expect(normalizePlan(output, LAST)).toEqual({
          plan: { tasks: [{ id: "1", intent: "query", request: LAST, status: "pending" }] },
          intent: "query",
          reason: PLAN_FALLBACK_REASON,
          fallback: true,
        });
      });
    }
  });
});

describe("la tarea que ve cada agente (R7)", () => {
  const task = (over: Partial<Task>): Task => ({ id: "1", intent: "query", request: "stock del gel", status: "pending", ...over });
  const human = new HumanMessage("registrá la venta y decime el stock");

  it("con una sola tarea no hay nada que agregar: el agente se comporta como antes de la fase 7", () => {
    const plan = { tasks: [task({ status: "running" })] };
    expect(sharedTask({ plan })).toBeUndefined();
    const input = agentInput("PROMPT", { messages: [human], plan });
    expect(input.map((m) => m.text)).toEqual(["PROMPT", human.text]);
  });

  it("sin plan (nodos sueltos y tests de fases anteriores) tampoco", () => {
    expect(agentInput("PROMPT", { messages: [human] }).map((m) => m.text)).toEqual(["PROMPT", human.text]);
  });

  it("la primera de varias tareas: su parte va en el prompt del sistema y no hay indicación extra", () => {
    const plan = { tasks: [task({ intent: "action", request: "registrá la venta", status: "running", startedAt: 1 }), task({ id: "2" })] };
    const input = agentInput("PROMPT", { messages: [human], plan });
    expect(input).toHaveLength(2);
    expect(input[0]!.text).toContain("A vos te toca solo esto: «registrá la venta»");
    expect(input[1]).toBe(human);
  });

  it("después de la respuesta de otro agente, la indicación va en el punto de arranque y sigue ahí en cada vuelta", () => {
    const plan = { tasks: [task({ intent: "action", status: "done" }), task({ id: "2", status: "running", startedAt: 2 })] };
    const previous = new AIMessage("Venta registrada.");
    const call = new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "getStockLevels", args: {}, type: "tool_call" }] });
    const result = new ToolMessage({ content: "{}", tool_call_id: "c1" });

    const first = agentInput("PROMPT", { messages: [human, previous], plan });
    expect(first.map((m) => m.type)).toEqual(["system", "human", "ai", "human"]);
    expect(first.at(-1)!.text).toContain("Seguí con tu parte del pedido: «stock del gel»");

    const loop = agentInput("PROMPT", { messages: [human, previous, call, result], plan });
    expect(loop.map((m) => m.type)).toEqual(["system", "human", "ai", "human", "ai", "tool"]);
  });

  it("si lo anterior es la persona o una herramienta, no se intercala nada", () => {
    const plan = { tasks: [task({ status: "done" }), task({ id: "2", status: "running", startedAt: 1 })] };
    expect(agentInput("P", { messages: [human], plan }).map((m) => m.type)).toEqual(["system", "human"]);
  });

  it("la indicación no se guarda: es solo lo que ve el modelo", () => {
    const messages = [human, new AIMessage("hecho")];
    const plan = { tasks: [task({ status: "done" }), task({ id: "2", status: "running", startedAt: 2 })] };
    agentInput("P", { messages, plan });
    expect(messages).toHaveLength(2);
  });
});
