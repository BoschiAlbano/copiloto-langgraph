import { loadEnvFile } from "../../src/config/env.js";
import { createCheckpointing } from "../../src/graph/checkpointing.js";

loadEnvFile();

/** Los tests de persistencia necesitan Postgres con el esquema `langgraph` (npm run db:reset). */
export const checkpointsUrl = process.env.DATABASE_URL_CHECKPOINTS;

/**
 * Una conexión nueva al checkpointer: abrir otra y cerrar la anterior simula reiniciar el programa. Con un pool chico:
 * varios archivos de tests corren a la vez y el pooler del Supabase local admite 20 clientes en total.
 */
export const openCheckpointing = () => createCheckpointing(checkpointsUrl!, { maxConnections: 2 });
