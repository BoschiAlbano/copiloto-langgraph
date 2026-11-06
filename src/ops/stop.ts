import { loadEnvFile } from "../config/env.js";
import { fail, hasDocker, isBundledDb, run } from "./common.js";

// `npm run stop` (fase 12, R2): para la base propia. Los datos quedan en su volumen; `npm run start` la vuelve a levantar.
loadEnvFile();
if (!isBundledDb(process.env.DATABASE_URL_WRITE ?? process.env.DATABASE_URL_CHECKPOINTS)) {
  console.log("La base de .env no es la propia (docker-compose.yml): no se toca. Pará tu Supabase como siempre.");
  process.exit(0);
}
if (!hasDocker()) fail("Docker no responde: la base ya está parada.");
if (!run("docker", ["compose", "stop", "db"])) fail("No se pudo parar la base.");
console.log("✓ Base parada. Los datos quedan guardados; `npm run start` la vuelve a levantar.");
