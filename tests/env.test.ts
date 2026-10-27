import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/config/env.js";

describe("parseEnv", () => {
  it("falla nombrando ANTHROPIC_API_KEY cuando falta", () => {
    expect(() => parseEnv({})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("rechaza una clave vacía", () => {
    expect(() => parseEnv({ ANTHROPIC_API_KEY: "" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("usa Haiku 5.5 como modelo por defecto", () => {
    const env = parseEnv({ ANTHROPIC_API_KEY: "sk-test" });
    expect(env.MODEL_AGENT).toBe("claude-haiku-5-5");
  });

  it("respeta MODEL_AGENT si está definido", () => {
    const env = parseEnv({ ANTHROPIC_API_KEY: "sk-test", MODEL_AGENT: "claude-sonnet-5-5" });
    expect(env.MODEL_AGENT).toBe("claude-sonnet-5-5");
  });
});
