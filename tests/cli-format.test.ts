import { describe, expect, it } from "vitest";
import { describeCheckpoint, describeThread, formatWhen } from "../src/cli/format.js";

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
