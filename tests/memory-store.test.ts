import { randomBytes } from "node:crypto";
import { InMemoryStore } from "@langchain/langgraph";
import { afterAll, describe, expect, it } from "vitest";
import { clearMemories, createMemoryStore, deleteMemory, listMemories, MEMORY_NAMESPACE, saveMemory, type MemoryBank } from "../src/memory/store.js";
import { checkpointsUrl } from "./helpers/checkpointing.js";

// La memoria de largo plazo sobre el Store de LangGraph (fase 8).

const NOW = new Date("2026-11-04T15:00:00Z");

describe("memorias sobre un Store en memoria", () => {
  const bank = (): MemoryBank => ({ store: new InMemoryStore(), namespace: ["test", "memorias"] });

  it("guarda, lista (de la más vieja a la más nueva) y borra", async () => {
    const b = bank();
    const first = await saveMemory(b, { kind: "rule", text: "Los lunes no se agendan turnos.", threadId: "hilo-a" }, NOW);
    const second = await saveMemory(b, { kind: "preference", text: "Decí los montos con la palabra pesos." }, new Date(NOW.getTime() + 1000));
    expect(first).toEqual({ id: expect.stringMatching(/^[0-9a-f]{6}$/), kind: "rule", text: "Los lunes no se agendan turnos.", createdAt: NOW.toISOString(), threadId: "hilo-a" });
    expect((await listMemories(b)).map((m) => m.text)).toEqual([first.text, second.text]);

    expect(await deleteMemory(b, first.id)).toEqual(first);
    expect(await listMemories(b)).toEqual([second]);
    expect(await deleteMemory(b, "no-existe")).toBeUndefined();
  });

  it("borrar todas deja el namespace vacío y no toca otros namespaces", async () => {
    const store = new InMemoryStore();
    const mine = { store, namespace: ["test", "a"] };
    const other = { store, namespace: ["test", "b"] };
    await saveMemory(mine, { kind: "rule", text: "uno" });
    await saveMemory(mine, { kind: "rule", text: "dos" });
    await saveMemory(other, { kind: "rule", text: "de otro" });
    expect(await clearMemories(mine)).toBe(2);
    expect(await listMemories(mine)).toEqual([]);
    expect((await listMemories(other)).map((m) => m.text)).toEqual(["de otro"]);
  });

  it("un valor que no cumple el esquema se ignora al listar", async () => {
    const b = bank();
    await b.store.put(b.namespace, "roto", { texto: "sin tipo" });
    await saveMemory(b, { kind: "rule", text: "válida" });
    expect((await listMemories(b)).map((m) => m.text)).toEqual(["válida"]);
  });

  it("el namespace de la aplicación es negocio / memorias", () => {
    expect(MEMORY_NAMESPACE).toEqual(["negocio", "memorias"]);
  });
});

describe.skipIf(!checkpointsUrl)("memorias sobre el Store de Postgres (CA8)", () => {
  // Un namespace propio por corrida: los tests nunca tocan las memorias reales del negocio.
  const namespace = ["test", `memorias-${randomBytes(4).toString("hex")}`];
  afterAll(async () => {
    const store = createMemoryStore(checkpointsUrl!);
    await clearMemories({ store, namespace });
    await store.stop();
  });

  it("con el rol copilot_checkpointer: una memoria guardada sobrevive a cerrar y abrir el Store (reinicio)", async () => {
    const first = createMemoryStore(checkpointsUrl!);
    const saved = await saveMemory({ store: first, namespace }, { kind: "rule", text: "Los lunes no se agendan turnos.", threadId: "hilo-a" }, NOW);
    await first.stop(); // el programa se cierra

    const second = createMemoryStore(checkpointsUrl!);
    expect(await listMemories({ store: second, namespace })).toEqual([saved]);
    expect(await deleteMemory({ store: second, namespace }, saved.id)).toEqual(saved);
    expect(await listMemories({ store: second, namespace })).toEqual([]);
    await second.stop();
  });
});
