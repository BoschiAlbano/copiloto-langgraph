import { describe, expect, it } from "vitest";
import {
  describeActionResult,
  describeCard,
  describeCheckpoint,
  describeReportStatus,
  describeRoute,
  describeThread,
  formatWhen,
  looksLikeEdit,
  parseDecisionInput,
  parseEditInput,
} from "../src/cli/format.js";

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

  it("si se vuelve a preguntar por un error, aclara que la propuesta anterior sigue pendiente", () => {
    expect(describeCard({ ...request, error: "Edición rechazada: x." }).join("\n")).toContain("SIGUE pendiente");
    expect(describeCard(request).join("\n")).not.toContain("SIGUE pendiente");
  });

  it("una propuesta editada avisa que todavía no se ejecutó nada y muestra lo que había propuesto el copiloto", () => {
    const text = describeCard({
      ...request,
      edited: true,
      action: { ...request.action, params: { appointmentId: 8 }, originalParams: { appointmentId: 7 } },
    }).join("\n");
    expect(text).toContain("TODAVÍA NO SE EJECUTÓ NADA");
    expect(text).toContain("Acción propuesta (editada)");
    expect(text).toContain('cancelAppointment {"appointmentId":8}');
    expect(text).toContain('el copiloto había propuesto: {"appointmentId":7}');
    expect(describeCard(request).join("\n")).not.toContain("TODAVÍA NO SE EJECUTÓ");
  });

  it("el resultado de la acción marca éxito o fallo", () => {
    expect(describeActionResult({ tool: "cancelAppointment", ok: true, message: "Turno #7 cancelado." })).toBe("  [acción] ✔ Turno #7 cancelado.");
    expect(describeActionResult({ tool: "adjustStock", ok: false, message: "No se pudo." })).toContain("✖");
  });
});

describe("describeReportStatus", () => {
  it("muestra el período y el estado de cada sección", () => {
    expect(describeReportStatus({ label: "semana del 26/10 al 01/11", sections: { sales: "ok", appointments: "ok", stock: "ok" } })).toBe(
      "[reporte] semana del 26/10 al 01/11 · ventas ✔ · turnos ✔ · stock ✔",
    );
    expect(describeReportStatus({ label: "octubre de 2026", sections: { sales: "ok", appointments: "error", stock: "missing" } })).toBe(
      "[reporte] octubre de 2026 · ventas ✔ · turnos ✖ · stock ✖",
    );
  });

  it("en la historia de checkpoints las tres secciones aparecen juntas en un mismo paso", () => {
    const line = describeCheckpoint({
      checkpointId: "1f1d328b-e3b8",
      source: "loop",
      step: 4,
      ranNodes: ["report_appointments", "report_sales", "report_stock"],
      next: ["compose_report"],
      messageCount: 1,
      intent: "report",
    });
    expect(line).toContain("corrió report_appointments+report_sales+report_stock");
    expect(line).toContain("sigue compose_report");
  });
});

describe("looksLikeEdit", () => {
  it("un JSON o un clave=valor pegados ante el «¿Aprobás?» se toman como una edición", () => {
    for (const input of ['{"sku":"AFT-001","delta":-1}', ' {"delta":-1', "delta=-1", "delta = 5; reason=x", '{"delta":-1,}']) {
      expect(looksLikeEdit(input), input).toBe(true);
    }
  });

  it("las respuestas normales no son ediciones", () => {
    for (const input of ["s", "n", "e", "no", "n porque sí", "sí", "aprobar", "", "hola", "quiero editar"]) {
      expect(looksLikeEdit(input), input).toBe(false);
    }
  });
});

describe("parseEditInput", () => {
  const current = { sku: "AFT-001", delta: 100, reason: "Ingreso de 100 unidades" };

  it("un cambio clave=valor se aplica sobre los parámetros actuales", () => {
    expect(parseEditInput("delta=50", current)).toEqual({ ok: true, params: { ...current, delta: 50 } });
    expect(parseEditInput("  delta = -5  ", current)).toEqual({ ok: true, params: { ...current, delta: -5 } });
  });

  it("varios cambios separados por «;», con texto libre en los valores", () => {
    expect(parseEditInput("delta=50; reason=Llegaron solo 50, no 100", current)).toEqual({
      ok: true,
      params: { sku: "AFT-001", delta: 50, reason: "Llegaron solo 50, no 100" },
    });
  });

  it("los valores se leen como JSON si pueden: números, textos entre comillas, booleanos", () => {
    expect(parseEditInput('reason="50 unidades"', current)).toMatchObject({ ok: true, params: { reason: "50 unidades" } });
    expect(parseEditInput("delta=1.5", current)).toMatchObject({ ok: true, params: { delta: 1.5 } }); // lo rechaza después el esquema
    expect(parseEditInput("delta=50x", current)).toMatchObject({ ok: true, params: { delta: "50x" } }); // idem: el esquema decide
  });

  it("un objeto JSON completo reemplaza todos los parámetros", () => {
    expect(parseEditInput('{"sku":"AFT-001","delta":50,"reason":"Llegaron 50"}', current)).toEqual({
      ok: true,
      params: { sku: "AFT-001", delta: 50, reason: "Llegaron 50" },
    });
  });

  it("lo que no se puede leer se informa y no produce parámetros", () => {
    const bad = ['{"sku":"AFT-001","delta":50,}', '{"delta":50', "{}x", "50", "s", "delta", "delta=", "=50", "delta=50;;", "9delta=5"];
    for (const input of bad) {
      const result = parseEditInput(input, current);
      expect(result.ok, input).toBe(false);
    }
    expect(parseEditInput('{"delta":50,}', current)).toMatchObject({ ok: false, error: expect.stringContaining("no es un JSON válido") });
    expect(parseEditInput("[1,2]", current)).toMatchObject({ ok: false });
  });

  it("no inventa parámetros: una clave que no existe se informa", () => {
    expect(parseEditInput("cantidad=50", current)).toMatchObject({ ok: false, error: expect.stringContaining("no es un parámetro") });
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

describe("describeRoute (fase 7)", () => {
  it("con una sola tarea es la línea de siempre", () => {
    expect(describeRoute({ intent: "query", reason: "pide un dato", tasks: [{ intent: "query", request: "x" }] })).toEqual(["[ruta] query: pide un dato"]);
  });

  it("con varias muestra el orden y la parte de cada una", () => {
    const route = {
      intent: "action" as const,
      reason: "registrar venta y consultar stock",
      tasks: [
        { intent: "action" as const, request: "Registrá la venta de un gel" },
        { intent: "query" as const, request: "Decime cuánto stock queda" },
      ],
    };
    expect(describeRoute(route)).toEqual([
      "[ruta] action → query: registrar venta y consultar stock",
      "       1. action: Registrá la venta de un gel",
      "       2. query: Decime cuánto stock queda",
    ]);
  });

  it("sin intención no muestra nada", () => {
    expect(describeRoute({})).toEqual([]);
  });
});
