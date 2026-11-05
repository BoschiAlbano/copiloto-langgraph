import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { safeTool } from "../../src/tools/safe.js";

// Fallas simuladas para los escenarios F1 a F3 (fase 10): la base no se apaga. Se envuelve la herramienta REAL con otra
// del mismo nombre y esquema que pasa por `safeTool`, así que los reintentos (y sus avisos en vivo) son los de verdad.

/** Un error transitorio de la base, como el que da un Postgres que no acepta conexiones. */
export const connectionRefused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

/**
 * La herramienta `real`, pero sus primeras `times` ejecuciones (o todas) fallan por conexión rechazada antes de llegar
 * a la base. Cuando no le toca fallar, hace la consulta real.
 */
export function failing(real: StructuredToolInterface, times: number | "always") {
  let attempts = 0;
  const run = safeTool(real.name, async (input: unknown) => {
    attempts++;
    if (times === "always" || attempts <= times) throw connectionRefused();
    return JSON.parse(String(await real.invoke(input as never)));
  });
  const wrapped = tool(run, { name: real.name, description: real.description, schema: real.schema as never });
  return Object.assign(wrapped, { attempts: () => attempts });
}
