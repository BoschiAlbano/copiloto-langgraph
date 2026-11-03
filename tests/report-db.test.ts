import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { runSection } from "../src/graph/report/sections.js";
import { buildTestGraph } from "./helpers/graph.js";
import { scriptedModel } from "./helpers/models.js";
import { hasDb, useDatabases } from "./tools/helpers.js";

// El reporte completo con la base REAL (rol de solo lectura), modelos falsos. Se comparan las cifras con consultas
// SQL independientes (con el dueño) y se comprueba que el reporte no escribe nada.
const NOW = new Date("2026-10-28T15:00:00Z");

describe.skipIf(!hasDb)("reporte con la base real", () => {
  const ctx = useDatabases();

  const run = async (kind: "this_week" | "this_month" | "last_month" | "today") => {
    const reading = scriptedModel(() => new AIMessage("• Lectura de prueba."));
    const graph = buildTestGraph({
      model: reading.model,
      tools: [],
      intent: "report",
      reportPlan: { async invoke() { return { parsed: { reason: "x", kind } }; } },
      reportSections: (section, reportId, range) => runSection(section, reportId, range, ctx.db),
      now: () => NOW,
    });
    const result = await graph.invoke({ messages: [new HumanMessage("resumen")] });
    // Las partes son privadas del subgrafo de reportes (fase 7): al grafo principal llega el estado de cada sección.
    return { text: result.messages.at(-1)!.text, report: result.report!, sections: result.report!.sections! };
  };

  const local = "(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date";

  it("CA2: las cifras de ventas, turnos y stock coinciden con SQL independiente", async () => {
    const { text, report } = await run("last_month"); // septiembre de 2026: período cerrado, con datos del seed
    expect([report.dateFrom, report.dateTo]).toEqual(["2026-09-01", "2026-09-30"]);

    const sales = (
      await ctx.sql.query(`SELECT COUNT(*)::int n, COALESCE(SUM(total),0)::int total FROM sales WHERE ${local} BETWEEN '2026-09-01' AND '2026-09-30'`)
    ).rows[0];
    const money = (n: number) => `$ ${n.toLocaleString("es-AR")}`;
    if (sales.n > 0) {
      expect(text).toContain(`${sales.n.toLocaleString("es-AR")} ${sales.n === 1 ? "venta" : "ventas"} por ${money(sales.total)}`);
      expect(text).toContain(`ticket promedio ${money(Math.round(sales.total / sales.n))}`);
      const byMethod = (await ctx.sql.query(`SELECT payment_method m, COUNT(*)::int n, SUM(total)::int t FROM sales WHERE ${local} BETWEEN '2026-09-01' AND '2026-09-30' GROUP BY 1`)).rows;
      for (const m of byMethod) expect(text).toContain(`${money(m.t)} (${m.n})`);
    }

    const appts = (
      await ctx.sql.query(
        `SELECT status, COUNT(*)::int n FROM appointments WHERE (starts_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN '2026-09-01' AND '2026-09-30' GROUP BY 1`,
      )
    ).rows;
    const total = appts.reduce((s, r) => s + r.n, 0);
    const cancelled = appts.find((r) => r.status === "cancelled")?.n ?? 0;
    if (total > 0) {
      expect(text).toContain(`${total.toLocaleString("es-AR")} ${total === 1 ? "turno" : "turnos"} en el período, ${total - cancelled} activos`);
      for (const r of appts) expect(text).toMatch(new RegExp(`(agendados|realizados|cancelados|ausentes) ${r.n}\\b`));
    }

    const stock = (await ctx.sql.query(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE stock < min_stock)::int low FROM products`)).rows[0];
    if (stock.low > 0) {
      expect(text).toContain(`${stock.low === 1 ? "1 producto está" : `${stock.low} productos están`} por debajo del mínimo, de ${stock.total} productos en total`);
      const low = (await ctx.sql.query(`SELECT name, sku, stock, min_stock FROM products WHERE stock < min_stock`)).rows;
      for (const p of low.slice(0, 10)) expect(text).toContain(`${p.name} (${p.sku}): ${p.stock} de ${p.min_stock}`);
    } else {
      expect(text).toContain("Ningún producto está por debajo del mínimo");
    }
  });

  it("incluye las tres secciones aunque el período no tenga ventas todavía (hoy)", async () => {
    const { text, sections } = await run("today");
    expect(sections).toEqual({ sales: "ok", appointments: "ok", stock: "ok" });
    for (const title of ["\nVentas\n", "\nTurnos\n", "\nStock\n"]) expect(text).toContain(title);
  });

  it("CA10: el reporte no escribe nada en la base", async () => {
    const snapshot = async () =>
      JSON.stringify(
        (
          await ctx.sql.query(
            `SELECT (SELECT COUNT(*) FROM sales)::int sales, (SELECT COUNT(*) FROM sale_items)::int sale_items,
                    (SELECT COUNT(*) FROM appointments)::int appointments, (SELECT COALESCE(SUM(stock),0) FROM products)::int stock,
                    (SELECT COUNT(*) FROM clients)::int clients, (SELECT COUNT(*) FROM action_log)::int action_log`,
          )
        ).rows[0],
      );
    const before = await snapshot();
    await run("this_month");
    await run("this_week");
    expect(await snapshot()).toBe(before);
  });
});
