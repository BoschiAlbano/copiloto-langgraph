import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Otra versión de los prompts (fase 11, R12): una carpeta con los archivos que cambian. Si `COPILOT_PROMPTS_DIR` está
 * definida, cada prompt se lee de ahí cuando la carpeta lo tiene, y de `src/graph/prompts/` cuando no. Se lee una vez,
 * al importar cada módulo: por eso `npm run eval -- --compare` corre cada versión en su propio proceso.
 */
export function promptsDir(): string | undefined {
  const dir = process.env.COPILOT_PROMPTS_DIR;
  if (!dir) return undefined;
  const full = resolve(dir);
  if (!existsSync(full)) throw new Error(`COPILOT_PROMPTS_DIR apunta a una carpeta que no existe: ${full}`);
  return full;
}

/**
 * Lee un prompt versionado. Recibe la URL ya armada con `new URL("../prompts/x.md", import.meta.url)` en el módulo que
 * lo usa (así cada prompt se resuelve desde su archivo). Se pasa por `href`: dentro de la app web (webpack), la URL
 * llega como un objeto de otro contexto que `readFileSync` no acepta; el texto de la URL vale en los dos lados.
 */
export function readPrompt(url: URL): string {
  const file = fileURLToPath(url.href);
  const dir = promptsDir();
  const override = dir ? resolve(dir, basename(file)) : undefined;
  return readFileSync(override && existsSync(override) ? override : file, "utf8");
}
