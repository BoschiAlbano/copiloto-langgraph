import { loadEnvFile } from "../config/env.js";
import { formatChecks, runChecks } from "./doctor-checks.js";

// `npm run doctor` (fase 12, R3): revisa la configuración, la base, los roles, los esquemas y la clave de la API, y dice
// qué arreglar. No gasta tokens. Sale con código 1 si algo falla (lo usan `setup` y `start`).
loadEnvFile();
const results = await runChecks(process.env);
console.log(formatChecks(results));
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n✗ ${failed} ${failed === 1 ? "problema" : "problemas"}.` : "\n✓ Todo en orden.");
process.exit(failed ? 1 : 0);
