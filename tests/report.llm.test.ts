import { AIMessage } from "@langchain/core/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkPlanCriteria, evaluatePlanner, formatPlanReport } from "../evals/report.js";
import { loadEnv, type Env } from "../src/config/env.js";
import { createAgent, type Agent } from "../src/graph/create-agent.js";
import { makeReportModel, makeReportPlanModel } from "../src/graph/models.js";
import { makeComposeReportNode } from "../src/graph/nodes/report.js";
import { unknownNumbers } from "../src/graph/report/numbers.js";
import { resolvePeriod, type Period } from "../src/graph/report/period.js";
import { renderReport } from "../src/graph/report/render.js";
import { runSection } from "../src/graph/report/sections.js";
import { SECTIONS, type Section } from "../src/graph/report/state.js";
import { runTurn } from "../src/graph/run-turn.js";
import { makeState } from "../src/graph/state.js";
import { TestThreads } from "./helpers/threads.js";
import { hasDb, useDatabases } from "./tools/helpers.js";

// Con el modelo real (centavos de API): solo corren si se pide.   $env:RUN_LLM_TESTS = "1"; npm test
const enabled = process.env.RUN_LLM_TESTS === "1";

describe.skipIf(!enabled)("reportes con el modelo real", () => {
  let env: Env;
  beforeAll(() => {
    env = loadEnv();
  });

  it("CA6: el planificador cumple P1 a P8 (7 de 8 como mínimo, y P1, P3 y P6 siempre) en tres corridas seguidas", async () => {
    const model = makeReportPlanModel(env);
    for (let run = 1; run <= 3; run++) {
      const results = await evaluatePlanner(model);
      expect(checkPlanCriteria(results).pass, `corrida ${run}\n${formatPlanReport(results)}`).toBe(true);
    }
  }, 240_000);

  describe.skipIf(!hasDb)("con la base", () => {
    const ctx = useDatabases();
    const threads = new TestThreads();
    let agent: Agent;
    beforeAll(() => {
      agent = createAgent(env);
    });
    afterAll(async () => {
      await threads.cleanup(agent.checkpointer, agent.traces);
      await agent.close();
    });

    it("CA7: la «Lectura» del modelo real nunca cita una cifra que no esté en el reporte (se mira la respuesta cruda, antes del descarte)", async () => {
      const periods: Period[] = [{ kind: "this_week" }, { kind: "last_month" }, { kind: "last_days", n: 30 }];
      const model = makeReportModel(env);
      const raw: string[] = [];
      const recording = { async invoke(messages: never) { const reply = await model.invoke(messages); raw.push(String(reply.text)); return reply as AIMessage; } };

      for (const period of periods) {
        const resolved = resolvePeriod(period);
        const reportId = `eval-${period.kind}`;
        const parts = await Promise.all(SECTIONS.map((s: Section) => runSection(s, reportId, resolved, ctx.db)));
        const report = { id: reportId, ...resolved };
        const { messages } = await makeComposeReportNode(recording, { warn: () => {} })(makeState([], { report, reportParts: parts }));

        const text = renderReport(report, parts);
        const reading = raw.at(-1)!;
        expect(reading.trim().length, `${period.kind}: respuesta vacía`).toBeGreaterThan(0);
        expect(unknownNumbers(reading, text), `${period.kind}\n${reading}`).toEqual([]);
        expect(messages[0]!.text, period.kind).toContain("\nLectura\n"); // y por lo tanto no se descartó
      }
    }, 120_000);

    it("de punta a punta: «armame el resumen de la semana» va por el router, el planificador, las tres secciones y la «Lectura»", async () => {
      const id = threads.fresh("llm");
      const turn = await runTurn(agent, id, "Armame el resumen de la semana.");
      expect(turn.route.intent).toBe("report");
      expect(turn.report?.sections).toEqual({ sales: "ok", appointments: "ok", stock: "ok" });
      expect(turn.summary.toolCalls).toEqual([]);
      // Planificador + «Lectura» (el router también cuenta): 3 llamadas al modelo en total.
      expect(turn.summary.modelCalls).toBe(3);

      const week = resolvePeriod({ kind: "this_week" });
      expect(turn.reply).toContain(`Reporte · ${week.label}`);
      const { rows } = await ctx.sql.query(
        `SELECT COUNT(*)::int n, COALESCE(SUM(total),0)::int total FROM sales
          WHERE (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN $1 AND $2`,
        [week.dateFrom, week.dateTo],
      );
      if (rows[0].n > 0) expect(turn.reply).toContain(`$ ${rows[0].total.toLocaleString("es-AR")}`);
      for (const title of ["\nVentas\n", "\nTurnos\n", "\nStock\n"]) expect(turn.reply).toContain(title);
    }, 120_000);
  });
});
