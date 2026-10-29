import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import type { PendingAction } from "../src/graph/approval.js";
import {
  ApprovalRequiredError,
  makeExecuteActionNode,
  makeProposeActionNode,
  ONE_ACTION_ONLY,
  type ActionRunner,
} from "../src/graph/nodes/actions.js";
import { makeState, type AgentStateType } from "../src/graph/state.js";
import type { ExecutionOutcome } from "../src/tools/actions/execute.js";
import { ToolUserError } from "../src/tools/safe.js";
import { toolCall } from "./helpers/models.js";

const config = { configurable: { thread_id: "hilo-1" } };
const state = (over: Partial<AgentStateType>) => makeState([], { intent: "action", pendingAction: null, approval: null, ...over });

const prepared = {
  tool: "cancelAppointment" as const,
  params: { appointmentId: 7 },
  risk: "medium" as const,
  summary: "Cancelar el turno #7 de Ana.",
};

/** Ejecutor falso: guarda cómo se lo llamó. Se le pueden cambiar las implementaciones. */
function fakeRunner(impl: Partial<ActionRunner> = {}) {
  return {
    prepare: vi.fn<ActionRunner["prepare"]>(impl.prepare ?? (async () => prepared)),
    execute: vi.fn<ActionRunner["execute"]>(
      impl.execute ?? (async (): Promise<ExecutionOutcome> => ({ status: "executed", message: "Turno #7 cancelado." })),
    ),
  };
}

describe("propose_action", () => {
  it("arma la propuesta con el resumen del código y un id único por hilo y llamada", async () => {
    const runner = fakeRunner();
    const update = await makeProposeActionNode(runner)(
      state({ messages: [new HumanMessage("cancelá"), toolCall("toolu_1", "cancelAppointment", { appointmentId: 7 })] }),
      config,
    );
    expect(update).toEqual({
      pendingAction: { id: "hilo-1:toolu_1", toolCallId: "toolu_1", tool: "cancelAppointment", params: { appointmentId: 7 }, risk: "medium", summary: prepared.summary },
      approval: null,
    });
    expect(runner.prepare).toHaveBeenCalledWith("cancelAppointment", { appointmentId: 7 }, expect.any(Date));
  });

  it("usa lo que normalizó prepare, no los parámetros crudos del modelo", async () => {
    const runner = fakeRunner({ prepare: async () => ({ ...prepared, params: { appointmentId: 7, normalizado: true } }) });
    const update = await makeProposeActionNode(runner)(
      state({ messages: [toolCall("t", "cancelAppointment", { appointmentId: 7, crudo: 1 })] }),
      config,
    );
    expect(update.pendingAction?.params).toEqual({ appointmentId: 7, normalizado: true });
  });

  it("una acción inválida vuelve al modelo como error de herramienta y no deja nada pendiente", async () => {
    const runner = fakeRunner({
      prepare: vi.fn(async () => {
        throw new ToolUserError("El turno 9 ya pasó.");
      }),
    });
    const update = await makeProposeActionNode(runner)(state({ messages: [toolCall("toolu_2", "cancelAppointment", { appointmentId: 9 })] }), config);
    expect(update.pendingAction).toBeNull();
    const [message] = update.messages as ToolMessage[];
    expect(ToolMessage.isInstance(message)).toBe(true);
    expect(message).toMatchObject({ tool_call_id: "toolu_2", status: "error" });
    expect(message!.text).toContain("El turno 9 ya pasó.");
    expect(message!.text).toContain("No se propuso ni se hizo nada");
  });

  it("varias llamadas en un mensaje: todas reciben el error, no se prepara nada y el historial queda válido", async () => {
    const runner = fakeRunner();
    const many = new AIMessage({
      content: "",
      tool_calls: [
        { id: "a", name: "cancelAppointment", args: { appointmentId: 1 }, type: "tool_call" },
        { id: "b", name: "cancelAppointment", args: { appointmentId: 2 }, type: "tool_call" },
        { id: "c", name: "findClient", args: { query: "walter" }, type: "tool_call" },
      ],
    });
    const update = await makeProposeActionNode(runner)(state({ messages: [many] }), config);
    expect(runner.prepare).not.toHaveBeenCalled();
    expect(update.pendingAction).toBeNull();
    const replies = update.messages as ToolMessage[];
    expect(replies.map((m) => m.tool_call_id)).toEqual(["a", "b", "c"]); // una respuesta por llamada
    for (const reply of replies) expect(reply.text).toBe(ONE_ACTION_ONLY);
  });

  it("una acción mezclada con una consulta tampoco se propone", async () => {
    const runner = fakeRunner();
    const mixed = new AIMessage({
      content: "",
      tool_calls: [
        { id: "a", name: "findClient", args: { query: "ana" }, type: "tool_call" },
        { id: "b", name: "adjustStock", args: { sku: "CER-001", delta: 1, reason: "x" }, type: "tool_call" },
      ],
    });
    const update = await makeProposeActionNode(runner)(state({ messages: [mixed] }), config);
    expect(runner.prepare).not.toHaveBeenCalled();
    expect(update.pendingAction).toBeNull();
  });

  it("una herramienta que no es una acción no se propone", async () => {
    const runner = fakeRunner();
    const update = await makeProposeActionNode(runner)(state({ messages: [toolCall("a", "findClient", { query: "ana" })] }), config);
    expect(runner.prepare).not.toHaveBeenCalled();
    expect(update.pendingAction).toBeNull();
  });

  it("sin thread_id no puede pausar: falla con un mensaje claro", async () => {
    await expect(makeProposeActionNode(fakeRunner())(state({ messages: [toolCall("a", "cancelAppointment", { appointmentId: 1 })] }))).rejects.toThrow(/thread_id/);
  });

  it("un error inesperado de la base no se tapa", async () => {
    const runner = fakeRunner({
      prepare: vi.fn(async () => {
        throw new Error("conexión caída");
      }),
    });
    await expect(makeProposeActionNode(runner)(state({ messages: [toolCall("a", "cancelAppointment", { appointmentId: 1 })] }), config)).rejects.toThrow(/conexión caída/);
  });
});

describe("execute_action", () => {
  const action: PendingAction = { id: "hilo-1:toolu_1", toolCallId: "toolu_1", tool: "cancelAppointment", params: { appointmentId: 7 }, risk: "medium", summary: prepared.summary };

  it("CA1 d: sin aprobación, o con una de otra acción, no llega a la base", async () => {
    const runner = fakeRunner();
    const run = makeExecuteActionNode(runner);
    const refused: Partial<AgentStateType>[] = [
      { pendingAction: null, approval: null },
      { pendingAction: action, approval: null },
      { pendingAction: action, approval: { actionId: "hilo-1:otra", decision: "approved" } },
      { pendingAction: action, approval: { actionId: action.id, decision: "invalid", error: "x" } },
      // Una edición (`revised`) todavía no es una aprobación: falta aprobar lo editado.
      { pendingAction: action, approval: { actionId: action.id, decision: "revised" } },
      { pendingAction: null, approval: { actionId: action.id, decision: "approved" } },
    ];
    for (const over of refused) {
      await expect(run(state(over), config)).rejects.toBeInstanceOf(ApprovalRequiredError);
    }
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("aprobar ejecuta exactamente la propuesta guardada y responde a la llamada del modelo", async () => {
    const runner = fakeRunner();
    const update = await makeExecuteActionNode(runner)(
      state({ pendingAction: action, approval: { actionId: action.id, decision: "approved" } }),
      config,
    );
    expect(runner.execute).toHaveBeenCalledWith(
      {
        threadId: "hilo-1",
        actionId: action.id,
        tool: "cancelAppointment",
        proposed: { appointmentId: 7 },
        params: { appointmentId: 7 },
        summary: action.summary,
        risk: "medium",
        decision: "approved",
      },
      expect.any(Date),
    );
    expect(update.pendingAction).toBeNull();
    expect(update.approval).toBeNull();
    expect(update.messages[0]).toMatchObject({ tool_call_id: "toolu_1", name: "cancelAppointment", status: "success" });
    expect(update.messages[0]!.text).toBe("Turno #7 cancelado.");
  });

  it("aprobar una propuesta editada ejecuta lo editado y conserva lo que propuso el modelo", async () => {
    const runner = fakeRunner();
    const edited: PendingAction = { ...action, params: { appointmentId: 8 }, originalParams: { appointmentId: 7 }, summary: "Cancelar el turno #8.", risk: "low" };
    await makeExecuteActionNode(runner)(
      state({ pendingAction: edited, approval: { actionId: action.id, decision: "approved", comment: "ahora sí" } }),
      config,
    );
    expect(runner.execute.mock.calls[0]![0]).toMatchObject({
      proposed: { appointmentId: 7 },
      params: { appointmentId: 8 },
      summary: "Cancelar el turno #8.",
      risk: "low",
      decision: "edited",
      comment: "ahora sí",
    });
  });

  it("rechazar después de editar registra lo que propuso el modelo y no ejecuta nada", async () => {
    const runner = fakeRunner({ execute: vi.fn(async () => ({ status: "rejected", message: "rechazada" }) as ExecutionOutcome) });
    const edited: PendingAction = { ...action, params: { appointmentId: 8 }, originalParams: { appointmentId: 7 } };
    await makeExecuteActionNode(runner)(state({ pendingAction: edited, approval: { actionId: action.id, decision: "rejected" } }), config);
    expect(runner.execute.mock.calls[0]![0]).toMatchObject({ decision: "rejected", proposed: { appointmentId: 7 } });
  });

  it("rechazar pasa la decisión al ejecutor para que la registre, con el comentario", async () => {
    const runner = fakeRunner({ execute: vi.fn(async () => ({ status: "rejected", message: "La persona rechazó la acción." }) as ExecutionOutcome) });
    const update = await makeExecuteActionNode(runner)(
      state({ pendingAction: action, approval: { actionId: action.id, decision: "rejected", comment: "no" } }),
      config,
    );
    expect(runner.execute.mock.calls[0]![0]).toMatchObject({ decision: "rejected", comment: "no" });
    expect(update.messages[0]).toMatchObject({ status: "success", tool_call_id: "toolu_1" });
  });

  it("una acción que falló al ejecutarse vuelve al modelo como error", async () => {
    const runner = fakeRunner({ execute: vi.fn(async () => ({ status: "failed", message: "No se pudo: ya pasó." }) as ExecutionOutcome) });
    const update = await makeExecuteActionNode(runner)(
      state({ pendingAction: action, approval: { actionId: action.id, decision: "approved" } }),
      config,
    );
    expect(update.messages[0]).toMatchObject({ status: "error" });
    expect(update.pendingAction).toBeNull();
  });

  it("si la base se cae, el error se propaga y la propuesta sigue en el estado para reintentar", async () => {
    const runner = fakeRunner({
      execute: vi.fn(async () => {
        throw new Error("conexión caída");
      }),
    });
    await expect(
      makeExecuteActionNode(runner)(state({ pendingAction: action, approval: { actionId: action.id, decision: "approved" } }), config),
    ).rejects.toThrow(/conexión caída/);
  });
});
