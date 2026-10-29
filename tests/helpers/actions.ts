import { vi } from "vitest";
import type { ActionRunner } from "../../src/graph/nodes/actions.js";
import type { ExecuteInput, ExecutionOutcome } from "../../src/tools/actions/execute.js";
import { describeZodError } from "../../src/tools/actions/rules.js";
import { ACTION_SCHEMAS, type ActionName } from "../../src/tools/actions/schemas.js";
import { ToolUserError } from "../../src/tools/safe.js";

/**
 * Ejecutor de acciones falso, en memoria: valida con los esquemas reales, arma un resumen determinístico y
 * registra lo que se ejecutaría. No toca ninguna base. Las reglas del negocio se prueban aparte, con la base.
 */
export function fakeActions(options: { summary?: (tool: ActionName, params: Record<string, unknown>) => string } = {}) {
  const executed: ExecuteInput[] = [];
  const prepare = vi.fn<ActionRunner["prepare"]>(async (tool, params) => {
    const parsed = ACTION_SCHEMAS[tool].safeParse(params);
    if (!parsed.success) throw new ToolUserError(`Parámetros inválidos para ${tool}: ${describeZodError(parsed.error)}.`);
    const normalized = parsed.data as Record<string, unknown>;
    if (JSON.stringify(normalized).includes("INVALIDO")) throw new ToolUserError("Ese dato no es válido para el negocio.");
    return {
      tool,
      params: normalized,
      risk: "medium",
      summary: options.summary?.(tool, normalized) ?? `${tool} ${JSON.stringify(normalized)}`,
    };
  });
  const execute = vi.fn<ActionRunner["execute"]>(async (input): Promise<ExecutionOutcome> => {
    executed.push(input);
    if (input.decision === "rejected") return { status: "rejected", message: "La persona rechazó la acción. No se modificó ningún dato." };
    return { status: "executed", message: `Hecho: ${input.tool} ${JSON.stringify(input.params)}.`, result: { ok: true } };
  });
  const runner: ActionRunner = { prepare, execute };
  return { runner, prepare, execute, executed };
}
