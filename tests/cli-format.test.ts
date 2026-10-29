import { describe, expect, it } from "vitest";
import { describeActionResult, describeCard, describeCheckpoint, describeThread, formatWhen, parseDecisionInput } from "../src/cli/format.js";

describe("tarjeta de aprobación", () => {
  const request = {
    kind: "approve_action" as const,
    action: {
      id: "h:1",
      toolCallId: "1",
      tool: "cancelAppointment" as const,
      params: { appointmentId: 7 },
      risk: "medium" as const,
      summary: "Cancelar el turno #7 de Ana.",
    },
  };

  it("muestra el resumen del código, el riesgo y los parámetros", () => {
    const text = describeCard(request).join("\n");
    expect(text).toContain("riesgo medio");
    expect(text).toContain("Cancelar el turno #7 de Ana.");
    expect(text).toContain('cancelAppointment {"appointmentId":7}');
    expect(text).toContain("[s] sí");
    expect(text).not.toContain("⚠");
  });

  it("si se vuelve a preguntar, muestra el motivo primero", () => {
    const text = describeCard({ ...request, error: "Decisión inválida: x." }).join("\n");
    expect(text.indexOf("Decisión inválida")).toBeLessThan(text.indexOf("Acción propuesta"));
  });

  it("el resultado de la acción marca éxito o fallo", () => {
    expect(describeActionResult({ tool: "cancelAppointment", ok: true, message: "Turno #7 cancelado." })).toBe("  [acción] ✔ Turno #7 cancelado.");
    expect(describeActionResult({ tool: "adjustStock", ok: false, message: "No se pudo." })).toContain("✖");
  });
});

describe("parseDecisionInput", () => {
  it("entiende aprobar, editar y rechazar con o sin motivo", () => {
    for (const yes of ["s", "S", "sí", "si", " aprobar ", "ok"]) expect(parseDecisionInput(yes), yes).toEqual({ decision: "approve" });
    for (const edit of ["e", "E", "editar"]) expect(parseDecisionInput(edit), edit).toEqual({ decision: "edit" });
    expect(parseDecisionInput("n")).toEqual({ decision: "reject" });
    expect(parseDecisionInput("no")).toEqual({ decision: "reject" });
    expect(parseDecisionInput("n porque es el turno equivocado")).toEqual({ decision: "reject", comment: "es el turno equivocado" });
    expect(parseDecisionInput("rechazar mejor mañana")).toEqual({ decision: "reject", comment: "mejor mañana" });
  });

  it("lo demás no se interpreta, para no aprobar por accidente", () => {
    for (const other of ["", "quizás", "sí, pero cambialo", "nunca", "snow", "listo", "dale", "y"]) {
      expect(parseDecisionInput(other), other).toBeNull();
    }
  });

  it("recorta los motivos largos a 200 caracteres", () => {
    const decision = parseDecisionInput(`n ${"x".repeat(500)}`);
    expect(decision).toMatchObject({ decision: "reject" });
    expect((decision as { comment: string }).comment).toHaveLength(200);
  });
});

describe("formatWhen", () => {
  it("muestra la hora de Argentina (UTC-3)", () => {
    expect(formatWhen("2026-10-28T23:38:00.000Z")).toMatch(/28\/10.*20:38/);
  });
  it("sin fecha, s/d", () => {
    expect(formatWhen(undefined)).toBe("s/d");
  });
});

describe("describeThread", () => {
  const base = {
    threadId: "hilo-1a2b3c4d",
    lastActivity: new Date("2026-10-28T23:38:00.000Z"),
    checkpoints: 12,
    messageCount: 4,
    firstMessage: "¿Cuántos turnos hay mañana?",
    pending: false,
    awaiting: false,
  };
  it("incluye id, mensajes y primer mensaje", () => {
    const line = describeThread(base);
    expect(line).toContain("hilo-1a2b3c4d");
    expect(line).toContain("4 msj");
    expect(line).toContain('"¿Cuántos turnos hay mañana?"');
    expect(line).not.toContain("a medias");
  });
  it("marca los hilos a medias", () => {
    expect(describeThread({ ...base, pending: true })).toContain("⚠ a medias");
  });
  it("marca los hilos que esperan una aprobación", () => {
    const line = describeThread({ ...base, awaiting: true });
    expect(line).toContain("⏸ espera tu aprobación");
    expect(line).not.toContain("a medias");
  });
});

describe("describeCheckpoint", () => {
  it("muestra el nodo que corrió, el que sigue y la ruta", () => {
    const line = describeCheckpoint({
      checkpointId: "1f1d328b-e3b8-63c0-8001-d72550ec3ed4",
      source: "loop",
      step: 1,
      ranNodes: ["router"],
      next: ["chat"],
      messageCount: 1,
      intent: "chat",
    });
    expect(line).toContain("corrió router");
    expect(line).toContain("sigue chat");
    expect(line).toContain("ruta chat");
    expect(line).toContain("1f1d328b");
  });
  it("el último checkpoint de un turno dice 'fin'", () => {
    expect(describeCheckpoint({ checkpointId: "x", source: "loop", step: 4, ranNodes: ["agent"], next: [], messageCount: 2 })).toContain(
      "sigue fin",
    );
  });
});
