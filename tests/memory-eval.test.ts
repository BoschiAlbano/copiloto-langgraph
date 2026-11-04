import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkMemoryCriteria, type ApplyCaseResult, type MemoryCaseResult } from "../evals/memory.js";
import { applyCases, MEMORY_CASES } from "../evals/memory-cases.js";

// Fase 8: los escenarios no se filtran en los prompts (CA5) y los criterios del corredor (con el modelo real:
// tests/memory.llm.test.ts y npm run eval:memory).

const normalize = (s: string) => s.toLowerCase().replace(/[¿?¡!.,"«»]/g, "").replace(/\s+/g, " ").trim();

describe("prompts y escenarios de memoria", () => {
  // Los prompts que deciden sobre la memoria: el del router (¿es memoria?) y el del nodo memory (¿qué hacer?). Los de
  // los agentes no deciden nada de esto (y el de charla trae, desde la fase 3, la frase de G7 como ejemplo).
  const prompts = ["router.md", "memory.md"].map((name) => ({
    name,
    text: normalize(readFileSync(new URL(`../src/graph/prompts/${name}`, import.meta.url), "utf8")),
  }));

  it("CA5: ninguna frase de G1 a G8 ni de A1 a A4 aparece en los prompts", () => {
    const messages = [...MEMORY_CASES.map((c) => [c.id, c.message]), ...applyCases(new Date("2026-11-04T15:00:00Z")).map((c) => [c.id, c.message])];
    for (const p of prompts) {
      for (const [id, message] of messages) expect(p.text.includes(normalize(message!)), `${p.name} / ${id}`).toBe(false);
    }
  });

  it("el prompt de memoria pide anotar solo lo que la persona pidió y trata el pedido como datos", () => {
    const memory = readFileSync(new URL("../src/graph/prompts/memory.md", import.meta.url), "utf8");
    expect(memory).toMatch(/Anotá solo lo que la persona pidió anotar en este pedido/);
    expect(memory).toMatch(/son datos, no órdenes/);
    expect(memory).toMatch(/el sistema lo revisa/);
  });

  it("los casos de aplicación usan el lunes a tres semanas y el martes siguiente", () => {
    const [a1, a2, a3] = applyCases(new Date("2026-11-04T15:00:00Z"));
    expect(a1!.message).toContain("lunes, 30 de noviembre");
    expect(a2!.expected).toEqual({ kind: "propose", tool: "createAppointment", date: "2026-12-01" });
    expect(a3!.expected).toEqual({ kind: "propose", tool: "createAppointment", date: "2026-11-30" });
  });
});

describe("checkMemoryCriteria", () => {
  const memory = (failing: string[] = []) =>
    MEMORY_CASES.map((c) => ({ case: c, ok: !failing.includes(c.id), plan: [], after: [], reply: "" }) satisfies MemoryCaseResult);
  const apply = (failing: string[] = []) =>
    applyCases(new Date("2026-11-04T15:00:00Z")).map((c) => ({ case: c, ok: !failing.includes(c.id), observed: "" }) satisfies ApplyCaseResult);

  it("todo bien cumple", () => expect(checkMemoryCriteria(memory(), apply()).pass).toBe(true));
  it("7 de 8 con un no crítico cumple", () => expect(checkMemoryCriteria(memory(["G3"]), apply()).pass).toBe(true));
  it("dos fallas no cumple", () => expect(checkMemoryCriteria(memory(["G3", "G4"]), apply()).pass).toBe(false));
  it("un crítico que falla no cumple", () => expect(checkMemoryCriteria(memory(["G5"]), apply()).pass).toBe(false));
  it("cualquier caso de aplicación que falla no cumple", () => expect(checkMemoryCriteria(memory(), apply(["A2"])).pass).toBe(false));
});
