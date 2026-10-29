import { money, PAYMENT_LABELS } from "../../tools/actions/rules.js";
import type { AppointmentsData, Report, ReportPart, SalesData, Section, StockData } from "./state.js";

// El texto del reporte. Lo arma el CÓDIGO a partir de los datos de las secciones: las cifras nunca pasan por un modelo.
// Es una función pura (los mismos datos dan siempre el mismo texto).

const MAX_LOW_PRODUCTS = 10;
const STATUS_ORDER = ["scheduled", "done", "cancelled", "no_show"];
const STATUS_LABELS: Record<string, string> = { scheduled: "agendados", done: "realizados", cancelled: "cancelados", no_show: "ausentes" };

const count = (n: number, singular: string, plural: string) => `${n.toLocaleString("es-AR")} ${n === 1 ? singular : plural}`;

function salesLines(d: SalesData): string[] {
  if (d.salesCount === 0) return ["• No hubo ventas en el período."];
  const methods = d.byPaymentMethod
    .map((m) => `${PAYMENT_LABELS[m.method as keyof typeof PAYMENT_LABELS] ?? m.method} ${money(m.total)} (${m.count})`)
    .join(" · ");
  return [
    `• ${count(d.salesCount, "venta", "ventas")} por ${money(d.totalRevenue)} · ticket promedio ${money(d.averageTicket)}`,
    `• Por medio de pago: ${methods}`,
    `• Servicios: ${money(d.byItemType.services.revenue)} (${count(d.byItemType.services.units, "unidad", "unidades")}) · Productos: ${money(d.byItemType.products.revenue)} (${count(d.byItemType.products.units, "unidad", "unidades")})`,
  ];
}

function appointmentsLines(d: AppointmentsData): string[] {
  if (d.total === 0) return ["• No hay turnos en el período."];
  const known = STATUS_ORDER.filter((s) => d.countByStatus[s]);
  const others = Object.keys(d.countByStatus).filter((s) => !STATUS_ORDER.includes(s) && d.countByStatus[s]);
  const byStatus = [...known, ...others].map((s) => `${STATUS_LABELS[s] ?? s} ${d.countByStatus[s]}`).join(" · ");
  return [`• ${count(d.total, "turno", "turnos")} en el período, ${d.activeCount} activos (sin contar cancelados)`, `• Por estado: ${byStatus}`];
}

function stockLines(d: StockData): string[] {
  if (d.lowCount === 0) return [`• Ningún producto está por debajo del mínimo (${count(d.total, "producto", "productos")} en total).`];
  const lines = [
    `• ${d.lowCount === 1 ? "1 producto está" : `${d.lowCount} productos están`} por debajo del mínimo, de ${count(d.total, "producto", "productos")} en total (stock de hoy):`,
    ...d.low.slice(0, MAX_LOW_PRODUCTS).map((p) => `  - ${p.name} (${p.sku}): ${p.stock} de ${p.minStock}`),
  ];
  if (d.low.length > MAX_LOW_PRODUCTS) lines.push(`  - y ${d.low.length - MAX_LOW_PRODUCTS} más`);
  return lines;
}

const SECTION_ORDER: { section: Section; title: string; lines: (data: never) => string[] }[] = [
  { section: "sales", title: "Ventas", lines: salesLines as (data: never) => string[] },
  { section: "appointments", title: "Turnos", lines: appointmentsLines as (data: never) => string[] },
  { section: "stock", title: "Stock", lines: stockLines as (data: never) => string[] },
];

/** Las partes de este reporte, por sección (ignora las de otros reportes que hubiera en el estado). */
export function partsOf(report: Pick<Report, "id">, parts: ReportPart[]): Partial<Record<Section, ReportPart>> {
  const out: Partial<Record<Section, ReportPart>> = {};
  for (const p of parts) if (p.reportId === report.id) out[p.section] = p;
  return out;
}

/** El reporte completo en texto. Una sección que falló, o que no llegó, dice «No disponible» y el motivo. */
export function renderReport(report: Pick<Report, "id" | "label" | "notice">, allParts: ReportPart[]): string {
  const parts = partsOf(report, allParts);
  const failed = SECTION_ORDER.filter(({ section }) => parts[section]?.status !== "ok");

  const out: string[] = [`Reporte · ${report.label}`];
  if (report.notice) out.push(`⚠ ${report.notice}`);
  if (failed.length === SECTION_ORDER.length) out.push("⚠ No se pudo armar ninguna de las tres secciones.");

  for (const { section, title, lines } of SECTION_ORDER) {
    const part = parts[section];
    out.push("", title);
    if (part?.status === "ok") out.push(...lines(part.data as never));
    else out.push(`• No disponible: ${part?.error ?? "no se recibió el resultado de esta sección"}.`);
  }
  return out.join("\n");
}

/** Cuántas secciones salieron bien, para la terminal y las trazas. */
export function sectionStatus(report: Pick<Report, "id">, allParts: ReportPart[]): Record<Section, "ok" | "error" | "missing"> {
  const parts = partsOf(report, allParts);
  return {
    sales: parts.sales?.status ?? "missing",
    appointments: parts.appointments?.status ?? "missing",
    stock: parts.stock?.status ?? "missing",
  };
}
