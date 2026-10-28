import type { Db } from "../db/client.js";
import { makeFindClientTool } from "./find-client.js";
import { makeGetSalesSummaryTool } from "./get-sales-summary.js";
import { makeGetStockLevelsTool } from "./get-stock-levels.js";
import { makeListAppointmentsTool } from "./list-appointments.js";

/**
 * Las únicas puertas del agente a la base de datos. `db` debe ser un cliente conectado
 * con el rol de solo lectura (DATABASE_URL_READ).
 */
export function makeReadTools(db: Db) {
  return [
    makeFindClientTool(db),
    makeListAppointmentsTool(db),
    makeGetSalesSummaryTool(db),
    makeGetStockLevelsTool(db),
  ];
}
