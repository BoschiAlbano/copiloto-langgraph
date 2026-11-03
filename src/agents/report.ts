import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { AgentModel } from "../graph/nodes/agent.js";
import {
  fanOutReport,
  makeComposeReportNode,
  makePlanReportNode,
  makeSectionNode,
  SECTION_NODES,
  type PlanModel,
  type SectionRunner,
} from "../graph/nodes/report.js";
import { ReportState } from "../graph/state.js";

export interface ReportGraphOptions {
  /** Modelo barato con salida estructurada: decide el período. */
  plan: PlanModel;
  /** SIN herramientas: escribe la «Lectura» a partir de datos ya calculados. */
  reading: AgentModel;
  /** Corre una sección (ventas, turnos o stock). Las tres corren a la vez. */
  sections: SectionRunner;
  now?: () => Date;
  warn?: (message: string) => void;
  /** Solo para probarlo suelto. Dentro del grafo principal usa el checkpointer de ese grafo. */
  checkpointer?: BaseCheckpointSaver;
}

/**
 * Agente de reportes (fase 7): el fan-out/fan-in de la fase 6 como subgrafo. `reportParts` es PRIVADO: las tres
 * secciones lo escriben en el mismo paso y solo lo lee `compose_report`; al grafo principal vuelven el mensaje y
 * `report` (con el estado de cada sección).
 *
 *                       ┌─ report_sales ────────┐
 *   START → plan_report ┼─ report_appointments ─┼─→ compose_report → END
 *            (Send ×3)  └─ report_stock ────────┘
 */
export function buildReportGraph({ plan, reading, sections, now, warn, checkpointer }: ReportGraphOptions) {
  return (
    new StateGraph(ReportState)
      .addNode("plan_report", makePlanReportNode(plan, { now, warn }))
      // Reciben una entrada propia por Send (no el estado), por eso el tipo se fuerza. Ninguna llama a un modelo.
      .addNode(SECTION_NODES.sales, makeSectionNode("sales", sections) as never)
      .addNode(SECTION_NODES.appointments, makeSectionNode("appointments", sections) as never)
      .addNode(SECTION_NODES.stock, makeSectionNode("stock", sections) as never)
      .addNode("compose_report", makeComposeReportNode(reading, { warn }))
      .addEdge(START, "plan_report")
      // Fan-out: plan_report devuelve tres Send. Fan-in: las tres convergen en compose_report, que corre una vez.
      .addConditionalEdges("plan_report", fanOutReport, [SECTION_NODES.sales, SECTION_NODES.appointments, SECTION_NODES.stock])
      .addEdge(SECTION_NODES.sales, "compose_report")
      .addEdge(SECTION_NODES.appointments, "compose_report")
      .addEdge(SECTION_NODES.stock, "compose_report")
      .addEdge("compose_report", END)
      .compile({ checkpointer })
  );
}
