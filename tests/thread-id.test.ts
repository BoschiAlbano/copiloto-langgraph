import { describe, expect, it } from "vitest";
import { newThreadId, parseThreadId } from "../src/graph/thread-id.js";

describe("parseThreadId", () => {
  it("acepta ids con letras, números, guion y guion bajo", () => {
    for (const id of ["a", "hilo-1a2b3c4d", "Mi_hilo-2", "x".repeat(64)]) {
      expect(parseThreadId(id)).toBe(id);
    }
  });

  it("rechaza lo que podría ser un problema, con un mensaje legible", () => {
    const bad = [
      "",
      "x".repeat(65),
      "con espacio",
      "comilla'simple",
      'comilla"doble',
      "punto;y;coma",
      "salto\nde linea",
      "hilo\n",
      "../../etc",
      "ñandú",
      "emoji😀",
      "a.b",
      "'; DROP TABLE langgraph.checkpoints; --",
    ];
    for (const id of bad) {
      expect(() => parseThreadId(id), JSON.stringify(id)).toThrow(/1 a 64 caracteres/);
    }
  });
});

describe("newThreadId", () => {
  it("genera ids válidos y distintos", () => {
    const ids = new Set(Array.from({ length: 50 }, newThreadId));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^hilo-[0-9a-f]{8}$/);
      expect(parseThreadId(id)).toBe(id);
    }
  });
});
