import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/config/env.js";
import { claude, claudeWhole } from "../src/graph/models.js";

// Fase 9: con el chat web, el grafo corre con el modo `messages`, que le pide a cada modelo que transmita. Los de salida
// estructurada (router, memoria, período del reporte) tienen que contestar todo junto: transmitida, la salida
// estructurada de Claude llegaba sin parsear y el router caía siempre a su respaldo (se vio con el modelo real).

const env = parseEnv({ ANTHROPIC_API_KEY: "sk-test", DATABASE_URL_READ: "x", DATABASE_URL_CHECKPOINTS: "x", DATABASE_URL_ACTIONS: "x" });

describe("modelos de Claude", () => {
  it("los de salida estructurada no transmiten (disableStreaming), aunque el constructor no tome la opción", () => {
    expect(claudeWhole(env, env.MODEL_ROUTER).disableStreaming).toBe(true);
  });

  it("los que le contestan a la persona sí transmiten", () => {
    expect(claude(env, env.MODEL_AGENT).disableStreaming).toBe(false);
  });
});
