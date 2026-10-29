// Escenarios congelados de la fase 6 (ver specs/fase-06-reportes-paralelo.md). Se escribieron ANTES de los
// prompts del planificador y de la «Lectura», y ninguna de estas frases aparece en ellos (lo verifica un test).
// Se evalúa el planificador con un reloj fijo, así el resultado esperado es siempre el mismo.

/** Martes 28 de octubre de 2026, 12:00 en Argentina. */
export const REPORT_NOW = new Date("2026-10-28T15:00:00Z");

export interface ReportCase {
  id: "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8";
  /** Si el escenario nunca puede fallar (CA6). */
  critical: boolean;
  message: string;
  /** Fechas esperadas (hora de Argentina). `dateFrom` admite más de una opción cuando la frase es ambigua. */
  expected: { dateFrom: string | string[]; dateTo: string };
}

export const REPORT_CASES: ReportCase[] = [
  {
    id: "P1",
    critical: true,
    message: "Armame el resumen de la semana.",
    expected: { dateFrom: "2026-10-26", dateTo: "2026-11-01" },
  },
  {
    id: "P2",
    critical: false,
    message: "Haceme un reporte del mes con ventas, turnos y stock.",
    expected: { dateFrom: "2026-10-01", dateTo: "2026-10-31" },
  },
  {
    id: "P3",
    critical: true,
    message: "Quiero un informe de cierre del día.",
    expected: { dateFrom: "2026-10-28", dateTo: "2026-10-28" },
  },
  {
    id: "P4",
    critical: false,
    message: "Dame un panorama completo del negocio de los últimos 30 días.",
    // «Últimos 30 días» con hoy incluido empieza el 29/09; contando 30 días hacia atrás, el 28/09. Las dos se aceptan.
    expected: { dateFrom: ["2026-09-29", "2026-09-28"], dateTo: "2026-10-28" },
  },
  {
    id: "P5",
    critical: false,
    message: "Resumen de la semana pasada.",
    expected: { dateFrom: "2026-10-19", dateTo: "2026-10-25" },
  },
  {
    id: "P6",
    critical: true,
    message: "Hacé un resumen.",
    // Sin período se usa la semana actual.
    expected: { dateFrom: "2026-10-26", dateTo: "2026-11-01" },
  },
  {
    id: "P7",
    critical: false,
    message: "Resumen del 5 al 12 de octubre.",
    expected: { dateFrom: "2026-10-05", dateTo: "2026-10-12" },
  },
  {
    id: "P8",
    critical: false,
    message: "Cómo estuvo el mes pasado en general.",
    expected: { dateFrom: "2026-09-01", dateTo: "2026-09-30" },
  },
];
