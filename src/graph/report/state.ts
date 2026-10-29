import { z } from "zod";

// Lo que viaja por el estado del grafo en un reporte.

export const SECTIONS = ["sales", "appointments", "stock"] as const;
export type Section = (typeof SECTIONS)[number];

/** El reporte en curso: lo decide `plan_report` y lo leen las secciones y `compose_report`. Se reemplaza en cada pedido. */
export const reportSchema = z.object({
  /** Único por reporte: separa las partes de un reporte de las de otro en el mismo hilo. */
  id: z.string().min(1),
  dateFrom: z.string(),
  dateTo: z.string(),
  /** Para el título, por ejemplo «semana del 26/10 al 01/11». */
  label: z.string(),
  /** Aviso para la persona, por ejemplo que no se pudo interpretar el período. */
  notice: z.string().optional(),
});
export type Report = z.infer<typeof reportSchema>;

/** El resultado de una sección. Si falló, `error` dice por qué en palabras de la persona. */
export const partSchema = z.object({
  reportId: z.string().min(1),
  section: z.enum(SECTIONS),
  status: z.enum(["ok", "error"]),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type ReportPart = z.infer<typeof partSchema>;

/** Datos de cada sección cuando salió bien (lo que consume `renderReport`). */
export interface SalesData {
  salesCount: number;
  totalRevenue: number;
  averageTicket: number;
  byPaymentMethod: { method: string; count: number; total: number }[];
  byItemType: { products: { units: number; revenue: number }; services: { units: number; revenue: number } };
}
export interface AppointmentsData {
  total: number;
  activeCount: number;
  countByStatus: Record<string, number>;
}
export interface StockData {
  total: number;
  lowCount: number;
  low: { name: string; sku: string; stock: number; minStock: number }[];
}

/**
 * Reducer del canal `reportParts`. Las tres secciones escriben en el mismo paso y sus partes se juntan sin pisarse,
 * en cualquier orden. Un reporte nuevo (otro `reportId`) reemplaza todo lo anterior, así el canal se reinicia solo y
 * no depende de ningún valor especial. Una sección repetida del mismo reporte (un reintento) reemplaza a la anterior.
 */
export function mergeParts(left: ReportPart[], right: ReportPart[]): ReportPart[] {
  if (right.length === 0) return left;
  const reportId = right[0]!.reportId;
  const incoming = new Set(right.map((p) => p.section));
  const kept = left.filter((p) => p.reportId === reportId && !incoming.has(p.section));
  return [...kept, ...right];
}
