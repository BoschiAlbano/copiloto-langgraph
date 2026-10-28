import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/config/env.js";

const valid = {
  ANTHROPIC_API_KEY: "sk-test",
  DATABASE_URL_READ: "postgresql://u:p@localhost:5432/postgres",
  DATABASE_URL_CHECKPOINTS: "postgresql://c:p@localhost:5432/postgres",
};

describe("parseEnv", () => {
  it("falla nombrando ANTHROPIC_API_KEY cuando falta", () => {
    const { ANTHROPIC_API_KEY: _, ...rest } = valid;
    expect(() => parseEnv(rest)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("falla nombrando DATABASE_URL_READ cuando falta", () => {
    const { DATABASE_URL_READ: _, ...rest } = valid;
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL_READ/);
  });

  it("falla nombrando DATABASE_URL_CHECKPOINTS cuando falta", () => {
    const { DATABASE_URL_CHECKPOINTS: _, ...rest } = valid;
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL_CHECKPOINTS/);
  });

  it("nombra todas las variables que faltan", () => {
    expect(() => parseEnv({})).toThrow(/ANTHROPIC_API_KEY.*DATABASE_URL_READ.*DATABASE_URL_CHECKPOINTS/);
  });

  it("rechaza una clave vacía", () => {
    expect(() => parseEnv({ ...valid, ANTHROPIC_API_KEY: "" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("usa Haiku 5.5 como modelo por defecto", () => {
    expect(parseEnv(valid).MODEL_AGENT).toBe("claude-haiku-5-5");
  });

  it("usa Haiku 5.5 como modelo del router por defecto y respeta MODEL_ROUTER", () => {
    expect(parseEnv(valid).MODEL_ROUTER).toBe("claude-haiku-5-5");
    expect(parseEnv({ ...valid, MODEL_ROUTER: "claude-sonnet-5-5" }).MODEL_ROUTER).toBe("claude-sonnet-5-5");
  });

  it("respeta MODEL_AGENT si está definido", () => {
    expect(parseEnv({ ...valid, MODEL_AGENT: "claude-sonnet-5-5" }).MODEL_AGENT).toBe("claude-sonnet-5-5");
  });
});
