import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import { log } from "../ops/log.js";

/** Esquema de Postgres donde LangGraph guarda los hilos, aparte de las tablas del negocio. */
export const CHECKPOINT_SCHEMA = "langgraph";

export interface Checkpointing {
  /** Lo que se le pasa a `compile({ checkpointer })`. */
  saver: PostgresSaver;
  /** El mismo pool, para las consultas propias (listar hilos). */
  pool: pg.Pool;
  close: () => Promise<void>;
}

/**
 * Conecta con el rol copilot_checkpointer. Las tablas ya existen: las crea `npm run db:checkpoints`.
 * `maxConnections`: los tests abren varios a la vez y el pooler del Supabase local admite 20 clientes en total.
 */
export function createCheckpointing(url: string, { maxConnections = 5 } = {}): Checkpointing {
  const pool = new pg.Pool({ connectionString: url, max: maxConnections });
  // Sin este oyente, una conexión ociosa que se cae tumba el proceso entero.
  pool.on("error", (error) => log.warn("conexion-ociosa-caida", `[checkpointer] conexión ociosa caída: ${error.message}`, { error }));
  const saver = new PostgresSaver(pool, undefined, { schema: CHECKPOINT_SCHEMA });
  return { saver, pool, close: () => pool.end() };
}
