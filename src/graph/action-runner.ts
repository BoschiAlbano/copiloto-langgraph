import type { Db } from "../db/client.js";
import { executeAction } from "../tools/actions/execute.js";
import { prepareAction } from "../tools/actions/prepare.js";
import type { ActionRunner } from "./nodes/actions.js";

/**
 * Une las dos mitades de una acción con SUS clientes de base de datos:
 *  - preparar (validar y resumir): rol de lectura, no puede escribir;
 *  - ejecutar: rol copilot_actions, el único con permisos de escritura. Solo lo llama `execute_action`.
 */
export function makeActionRunner(readDb: Db, actionsDb: Db): ActionRunner {
  return {
    prepare: (tool, params, now) => prepareAction(readDb, tool, params, now),
    execute: (input, now) => executeAction(actionsDb, input, now),
  };
}
