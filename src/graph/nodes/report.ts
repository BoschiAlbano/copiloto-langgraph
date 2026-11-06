import { randomUUID } from "node:crypto";
import { readPrompt } from "../prompts/read.js";
import { invokeWithCorrection } from "../structured.js";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Send } from "@langchain/langgraph";
import { describeNow } from "../../tools/dates.js";
import { buildRouterContext, formatTranscript } from "../router-context.js";
import { unknownNumbers } from "../report/numbers.js";
import { DEFAULT_PERIOD, PeriodError, resolvePeriod } from "../report/period.js";
import { PLAN_FALLBACK_NOTICE, toPeriod } from "../report/plan.js";
import { sharedTask, type TaskState } from "../plan.js";
import { partsOf, renderReport, sectionStatus } from "../report/render.js";
import { SECTIONS, type Report, type ReportPart, type Section } from "../report/state.js";
import type { AgentModel } from "./agent.js";
import type { RouterModel } from "./router.js";
import { log } from "../../ops/log.js";

/** Lo que leen los nodos del reporte: el estado del subgrafo de reportes (fase 7). */
export interface ReportNodeState extends TaskState {
  report?: Report;
  reportParts: ReportPart[];
}

// Los nodos del reporte (fase 6; desde la fase 7, dentro del subgrafo de reportes):
//   plan_report      decide el período (modelo barato, salida estructurada) y las fechas las calcula el código
//   report_<sección> tres nodos que corren A LA VEZ (fan-out con Send); no llaman a ningún modelo
//   compose_report   fan-in: arma el texto con las cifras (código) y le suma la «Lectura» del modelo

const planPrompt = readPrompt(new URL("../prompts/report-plan.md", import.meta.url));
const composePrompt = readPrompt(new URL("../prompts/report.md", import.meta.url));

export const renderPlanPrompt = (now: Date) => planPrompt.replace("{{currentDateTime}}", describeNow(now));

/** Nombre del nodo de cada sección. */
export const SECTION_NODES = {
  sales: "report_sales",
  appointments: "report_appointments",
  stock: "report_stock",
} as const satisfies Record<Section, string>;

/** Cómo se corre una sección: en producción usa la base (rol de lectura); en los tests, una versión falsa. */
export type SectionRunner = (section: Section, reportId: string, range: { dateFrom: string; dateTo: string }) => Promise<ReportPart>;

/** El planificador: lo mismo que el router, un modelo con salida estructurada que devuelve `{ parsed }`. */
export type PlanModel = RouterModel;

export function makePlanReportNode(
  model: PlanModel,
  options: { now?: () => Date; newId?: () => string; warn?: (message: string) => void } = {},
) {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const warn = options.warn ?? ((message: string) => log.warn("reporte", message));
  return async (state: Pick<ReportNodeState, "messages" | "plan">): Promise<{ report: Report }> => {
    const transcript = formatTranscript(buildRouterContext(state.messages));
    // En un pedido de varias partes (fase 7), el planificador recibe además la parte que es el reporte.
    const task = sharedTask(state);
    const request = task ? `\n\nLa parte del pedido que es el reporte: «${task.request}».` : "";
    // Un error real de la API no se atrapa (sube hasta la terminal). Una salida inválida sí: fase 10, un segundo
    // intento con la corrección; si tampoco sirve, semana actual y aviso.
    const at = now();
    const { value } = await invokeWithCorrection(
      model,
      [
        new SystemMessage(renderPlanPrompt(at)),
        new HumanMessage(`Conversación reciente:\n${transcript}${request}\n\nElegí el período del último pedido de reporte de la persona.`),
      ],
      (parsed) => {
        const period = toPeriod(parsed);
        if (!period) return { ok: false, error: "el período no cumple el esquema (kind y, si hace falta, las fechas)" };
        const resolved = tryResolve(period, at);
        if (!resolved) return { ok: false, error: "las fechas del período no son válidas (formato AAAA-MM-DD, la primera antes que la segunda, dentro del rango permitido)" };
        return { ok: true, value: resolved };
      },
      { warn, label: "reporte" },
    );
    let notice: string | undefined;
    let resolved = value;
    if (!resolved) {
      warn("[reporte] No se pudo interpretar el período tampoco en el segundo intento: se usa la semana actual.");
      notice = PLAN_FALLBACK_NOTICE;
      resolved = resolvePeriod(DEFAULT_PERIOD, at);
    }
    return { report: { id: newId(), dateFrom: resolved.dateFrom, dateTo: resolved.dateTo, label: resolved.label, ...(notice && { notice }) } };
  };
}

function tryResolve(period: Parameters<typeof resolvePeriod>[0], now: Date) {
  try {
    return resolvePeriod(period, now);
  } catch (error) {
    if (error instanceof PeriodError) return undefined;
    throw error;
  }
}

/**
 * Arista condicional del planificador. En vez de devolver el nombre de UN nodo devuelve una lista de `Send`: LangGraph
 * lanza un nodo por cada uno en el MISMO paso, cada uno con su propia entrada (no con el estado completo).
 */
export function fanOutReport(state: Pick<ReportNodeState, "report">): Send[] {
  const report = state.report;
  if (!report) throw new Error("fanOutReport necesita un reporte planificado.");
  const input: SectionInput = { reportId: report.id, dateFrom: report.dateFrom, dateTo: report.dateTo };
  return SECTIONS.map((section) => new Send(SECTION_NODES[section], input));
}

/** Lo que recibe cada nodo de sección: solo lo que necesita. */
export interface SectionInput {
  reportId: string;
  dateFrom: string;
  dateTo: string;
}

/** Un nodo de sección. Escribe su parte en `reportParts`, cuyo reducer junta las tres. Nunca lanza (ver `runSection`). */
export function makeSectionNode(section: Section, run: SectionRunner) {
  return async (input: SectionInput): Promise<{ reportParts: ReportPart[] }> => ({
    reportParts: [await run(section, input.reportId, { dateFrom: input.dateFrom, dateTo: input.dateTo })],
  });
}

export const READING_FAILED_NOTICE = "(No pude agregar la «Lectura» del reporte; las cifras de arriba están completas.)";
export const READING_DISCARDED_NOTICE = "(Descarté la «Lectura» del reporte porque citaba una cifra que no está en los datos; las de arriba son las correctas.)";

export function makeComposeReportNode(model: AgentModel, options: { warn?: (message: string) => void } = {}) {
  const warn = options.warn ?? ((message: string) => log.warn("reporte", message));
  return async (state: Pick<ReportNodeState, "report" | "reportParts">): Promise<{ messages: AIMessage[]; report: Report }> => {
    const planned = state.report;
    if (!planned) throw new Error("compose_report necesita un reporte planificado.");
    // El estado de cada sección viaja en `report`, que es compartido: las partes quedan dentro del subgrafo.
    const report: Report = { ...planned, sections: sectionStatus(planned, state.reportParts) };
    const text = renderReport(report, state.reportParts);
    const parts = partsOf(report, state.reportParts);
    const anyOk = SECTIONS.some((s) => parts[s]?.status === "ok");

    // Sin ninguna sección no hay nada que leer: el reporte ya explica qué falló.
    if (!anyOk) return { messages: [new AIMessage(text)], report };

    let reading: string | undefined;
    let notice: string | undefined;
    try {
      const reply = await model.invoke([
        new SystemMessage(composePrompt),
        new HumanMessage(`Período: ${report.label}\n\nDatos del reporte (JSON):\n${JSON.stringify(readingInput(report, parts))}`),
      ]);
      const candidate = reply.text.trim();
      if (candidate) {
        const invented = unknownNumbers(candidate, text);
        if (invented.length === 0) reading = candidate;
        else {
          warn(`[reporte] La «Lectura» citaba cifras que no están en los datos (${invented.join(", ")}): se descarta.`);
          notice = READING_DISCARDED_NOTICE;
        }
      }
    } catch (error) {
      warn(`[reporte] Falló la llamada del modelo para la «Lectura»: ${(error as Error).message}`);
      notice = READING_FAILED_NOTICE;
    }
    const body = reading ? `${text}\n\nLectura\n${reading}` : notice ? `${text}\n\n${notice}` : text;
    return { messages: [new AIMessage(body)], report };
  };
}

/** Los datos que ve el modelo para la «Lectura»: las secciones, o el motivo por el que faltan. */
function readingInput(report: Pick<Report, "id" | "label">, parts: Partial<Record<Section, ReportPart>>) {
  return Object.fromEntries(
    SECTIONS.map((s) => {
      const part = parts[s];
      return [s, part?.status === "ok" ? part.data : { noDisponible: part?.error ?? "no se recibió el resultado" }];
    }),
  );
}
