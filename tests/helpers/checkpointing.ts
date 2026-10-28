import { loadEnvFile } from "../../src/config/env.js";
import { createCheckpointing } from "../../src/graph/checkpointing.js";

loadEnvFile();

/** Los tests de persistencia necesitan Postgres con el esquema `langgraph` (npm run db:reset). */
export const checkpointsUrl = process.env.DATABASE_URL_CHECKPOINTS;

/** Una conexión nueva al checkpointer: abrir otra y cerrar la anterior simula reiniciar el programa. */
export const openCheckpointing = () => createCheckpointing(checkpointsUrl!);
