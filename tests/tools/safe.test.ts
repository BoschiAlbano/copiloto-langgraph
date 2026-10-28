import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeTool, ToolUserError } from "../../src/tools/safe.js";

describe("safeTool", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("devuelve el resultado como JSON", async () => {
    const run = safeTool("demo", async (n: number) => ({ doble: n * 2 }));
    expect(await run(4)).toBe('{"doble":8}');
  });

  it("deja pasar los errores pensados para el modelo, con su mensaje", async () => {
    const run = safeTool("demo", async () => {
      throw new ToolUserError("No hay ningún barbero que coincida. Barberos: Martín, Lucas.");
    });
    await expect(run(null)).rejects.toThrow(/Barberos: Martín, Lucas/);
  });

  it("oculta el detalle interno de un error inesperado y conserva el código de Postgres", async () => {
    const run = safeTool("findClient", async () => {
      throw Object.assign(new Error('Raw query failed. password authentication failed for user "copilot_reader"'), {
        code: "P2010",
        meta: { code: "28P01" },
      });
    });
    const error = await run(null).catch((e: Error) => e);
    expect((error as Error).message).toContain("findClient");
    expect((error as Error).message).toContain("28P01");
    expect((error as Error).message).not.toContain("copilot_reader");
    expect((error as Error).message).not.toContain("password");
  });

  it("manda el detalle completo a la consola de quien opera el sistema", async () => {
    const run = safeTool("demo", async () => {
      throw new Error("detalle interno");
    });
    await run(null).catch(() => {});
    expect(console.error).toHaveBeenCalled();
  });

  it("funciona sin código de base (errores que no vienen de Postgres)", async () => {
    const run = safeTool("demo", async () => {
      throw new TypeError("x is undefined");
    });
    await expect(run(null)).rejects.toThrow(/problema del sistema\. No depende/);
  });
});
