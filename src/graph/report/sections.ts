import type { Db } from "../../db/client.js";
import { announceRetry } from "../../tools/retry-events.js";
import { withRetry } from "../../tools/retry.js";
import { explainError } from "../../tools/safe.js";
import { getSalesSummary } from "../../tools/get-sales-summary.js";
import { getStockLevels } from "../../tools/get-stock-levels.js";
import { listAppointments } from "../../tools/list-appointments.js";
import type { AppointmentsData, ReportPart, SalesData, Section, StockData } from "./state.js";

// Las tres secciones de un reporte. No llaman a ningún modelo: ejecutan las MISMAS funciones de lectura que las
// herramientas del agente (mismos límites y mismas reglas), con el cliente del rol de solo lectura.
// Una sección nunca lanza: si falla, devuelve una parte con `status: "error"` y el motivo, y el reporte sigue.

export interface SectionRange {
  dateFrom: string;
  dateTo: string;
}

async function salesSection(db: Db, { dateFrom, dateTo }: SectionRange): Promise<SalesData> {
  const s = await getSalesSummary(db, { dateFrom, dateTo });
  return {
    salesCount: s.salesCount,
    totalRevenue: s.totalRevenue,
    averageTicket: s.averageTicket,
    byPaymentMethod: s.byPaymentMethod,
    byItemType: s.byItemType,
  };
}

async function appointmentsSection(db: Db, { dateFrom, dateTo }: SectionRange): Promise<AppointmentsData> {
  // Solo se necesitan los totales, no las filas: `limit: 0`. El rango máximo (31 días) lo impone la propia función.
  const a = await listAppointments(db, { dateFrom, dateTo }, { limit: 0 });
  return { total: a.total, activeCount: a.activeCount, countByStatus: a.countByStatus };
}

async function stockSection(db: Db): Promise<StockData> {
  // El stock es el de hoy, no el del período. Los productos bajo el mínimo vienen primero.
  const s = await getStockLevels(db, {});
  return {
    total: s.total,
    lowCount: s.lowCount,
    low: s.products.filter((p) => p.isLow).map((p) => ({ name: p.name, sku: p.sku, stock: p.stock, minStock: p.minStock })),
  };
}

const RUNNERS: Record<Section, (db: Db, range: SectionRange) => Promise<unknown>> = {
  sales: salesSection,
  appointments: appointmentsSection,
  stock: (db) => stockSection(db),
};

/** Corre una sección y devuelve su parte. Nunca lanza. */
export async function runSection(section: Section, reportId: string, range: SectionRange, db: Db): Promise<ReportPart> {
  try {
    // Fase 10: una falla transitoria de la base se reintenta (como en las herramientas); si no se arregla, la sección
    // sale con error y el reporte dice cuál falta (fase 6).
    const data = await withRetry(() => RUNNERS[section](db, range), {
      onRetry: (info) => {
        console.warn(`[reintento] sección ${section} ${info.attempt} de ${info.attempts}`);
        announceRetry({ target: `section:${section}`, attempt: info.attempt, attempts: info.attempts });
      },
    });
    return { reportId, section, status: "ok", data };
  } catch (error) {
    return { reportId, section, status: "error", error: explainError(`sección ${section} del reporte`, error) };
  }
}
