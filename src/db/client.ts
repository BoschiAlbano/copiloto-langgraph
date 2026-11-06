import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "./generated/client.js";

/**
 * El límite de cada consulta de la aplicación (fase 12, R6). Se fija con un `SET` al abrir cada conexión: el pooler de
 * Supabase (Supavisor) no aplica el `statement_timeout` del rol (sí aplica `default_transaction_read_only`) ni el que
 * se pide al conectarse, pero respeta el de la sesión. `npm run db:roles` lo fija además en los roles, para las
 * conexiones directas.
 */
export const STATEMENT_TIMEOUT_MS = 10_000;

/** Un PrismaClient por proceso: cada instancia abre su propio pool de conexiones. */
export function createPrisma(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  // node-postgres pone en cola las consultas de una conexión: el SET corre antes que cualquier consulta de Prisma.
  pool.on("connect", (client) => {
    client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`).catch(() => undefined);
  });
  return new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
}

export type Db = ReturnType<typeof createPrisma>;
