import { AIMessage } from "@langchain/core/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionCases, mondayInThreeWeeks } from "../../evals/action-cases.js";
import { loadEnv } from "../../src/config/env.js";
import { createPrisma, type Db } from "../../src/db/client.js";
import { makeActionRunner } from "../../src/graph/action-runner.js";
import { continueTurn, resumeTurn, runTurn } from "../../src/graph/run-turn.js";
import { getStatus } from "../../src/graph/threads.js";
import { checkpointsUrl, openCheckpointing } from "../helpers/checkpointing.js";
import { buildTestGraph } from "../helpers/graph.js";
import { echoModel, scriptedModel, toolCall } from "../helpers/models.js";
import { TestThreads } from "../helpers/threads.js";
import { actionsUrl, hasWriteDb, readUrl, TEST_SKU, TEST_THREAD_PREFIX, useWriteFixtures } from "./fixtures.js";

// El grafo completo con la base de negocio REAL (roles de lectura y de acciones) y modelos guionados. Es la
// prueba de que ninguna escritura ocurre sin aprobación y de que lo aprobado es lo que se ejecuta.
describe.skipIf(!hasWriteDb || !checkpointsUrl)("flujo de aprobación con la base real", () => {
  const fx = useWriteFixtures();
  const threads = new TestThreads();
  let readDb: Db;
  let actionsDb: Db;
  const monday = mondayInThreeWeeks(new Date());

  beforeAll(() => {
    loadEnv(); // valida que el .env tenga las tres URLs
    readDb = createPrisma(readUrl!);
    actionsDb = createPrisma(actionsUrl!);
  });
  afterAll(async () => {
    await readDb.$disconnect();
    await actionsDb.$disconnect();
    const cp = openCheckpointing();
    await threads.cleanup(cp.saver);
    await cp.close();
  });

  /** Un "programa" con el ejecutor real: lectura con copilot_reader, escritura con copilot_actions. */
  const program = (script: AIMessage[]) => {
    const cp = openCheckpointing();
    const action = scriptedModel(script);
    const graph = buildTestGraph({
      model: echoModel().model,
      actionModel: action.model,
      tools: [],
      actions: makeActionRunner(readDb, actionsDb),
      intent: "action",
      checkpointer: cp.saver,
    });
    return { agent: { graph }, graph, cp, action, close: () => cp.close() };
  };

  /** Foto de todo lo que una acción podría tocar, para comparar antes y después. */
  const snapshot = async () => {
    const count = async (sql: string, params: unknown[] = []) => (await fx.sql.query(sql, params)).rows[0].n as number;
    return {
      appointments: await count(`SELECT COUNT(*)::int n FROM appointments`),
      cancelled: await count(`SELECT COUNT(*)::int n FROM appointments WHERE status = 'cancelled'`),
      sales: await count(`SELECT COUNT(*)::int n FROM sales`),
      saleItems: await count(`SELECT COUNT(*)::int n FROM sale_items`),
      stock: (await fx.sql.query(`SELECT sku, stock FROM products ORDER BY sku`)).rows,
      log: await count(`SELECT COUNT(*)::int n FROM action_log`),
    };
  };
  const logOf = async (threadId: string) => (await fx.sql.query(`SELECT * FROM action_log WHERE thread_id = $1 ORDER BY id`, [threadId])).rows;

  const newAppointment = async (startsAt: Date) =>
    (
      await fx.sql.query(
        `INSERT INTO appointments (client_id, staff_id, service_id, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [fx.clientId, fx.staffId, fx.serviceId, startsAt, new Date(startsAt.getTime() + 30 * 60_000)],
      )
    ).rows[0].id as number;

  const calls = {
    create: (id: string) => toolCall(id, "createAppointment", { clientId: fx.clientId, staffName: "lucas", serviceName: "corte", date: monday.iso, time: "15:00" }),
    sale: (id: string) => toolCall(id, "registerSale", { clientId: fx.clientId, paymentMethod: "cash", items: [{ sku: TEST_SKU.toLowerCase(), qty: 2 }] }),
    stock: (id: string) => toolCall(id, "adjustStock", { sku: TEST_SKU, delta: 7, reason: "Llegó un pedido" }),
  };

  it("CA1 a: las cuatro acciones se pausan sin tocar la base; los datos solo cambian después de aprobar", async () => {
    const apptId = await newAppointment(new Date(Date.now() + 250 * 86_400_000));
    const cancel = toolCall("c", "cancelAppointment", { appointmentId: apptId });
    for (const call of [calls.create("a"), cancel, calls.sale("s"), calls.stock("k")]) {
      const id = threads.fresh();
      const p = program([call, new AIMessage("ok")]);
      const before = await snapshot();

      const turn = await runTurn(p.agent, id, "pedido de cambio");
      expect(turn.awaiting?.action.tool, call.tool_calls![0]!.name).toBe(call.tool_calls![0]!.name);
      expect(await snapshot()).toEqual(before); // pausado: ni una fila cambió, ni siquiera la auditoría
      await p.close();
    }
  });

  it("CA4/CA5: aprobar después de reiniciar crea el turno, una sola vez, y lo deja en la auditoría", async () => {
    const id = threads.fresh();
    const first = program([calls.create("toolu_c")]);
    const proposed = await runTurn(first.agent, id, "Agendá un corte");
    await first.close();
    expect(proposed.awaiting?.action.params).toMatchObject({ staffName: "Lucas", serviceName: "Corte" }); // normalizado
    expect(proposed.awaiting?.action.summary).toContain("TST Cliente Fase5");

    const second = program([new AIMessage("Listo, quedó agendado.")]);
    const done = await resumeTurn(second.agent, id, { decision: "approve" });
    await second.close();

    expect(done.summary.actions[0]).toMatchObject({ tool: "createAppointment", ok: true });
    expect(done.summary.actions[0]!.message).toMatch(/^Turno #\d+ agendado: Corte con Lucas/);
    const made = (await fx.sql.query(`SELECT * FROM appointments WHERE client_id = $1 AND status = 'scheduled'`, [fx.clientId])).rows;
    expect(made.filter((a) => new Date(a.starts_at).toISOString() === `${monday.iso}T18:00:00.000Z`)).toHaveLength(1);
    const log = await logOf(id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ thread_id: id, action: "createAppointment", decision: "approved" });
    expect(log[0].decided_at).toBeInstanceOf(Date);

    // Aprobar otra vez no existe: el hilo ya no espera nada.
    const third = program([]);
    await expect(resumeTurn(third.agent, id, { decision: "approve" })).rejects.toThrow(/no está esperando/);
    await third.close();
  });

  it("CA2: rechazar no modifica ningún dato de negocio y deja el rechazo en la auditoría", async () => {
    const id = threads.fresh();
    const p = program([calls.stock("k"), new AIMessage("Entendido.")]);
    const before = await snapshot();
    await runTurn(p.agent, id, "Sumá stock");
    await resumeTurn(p.agent, id, { decision: "reject", comment: "Esperá al conteo" });
    const after = await snapshot();
    expect({ ...after, log: 0 }).toEqual({ ...before, log: 0 });
    expect(after.log).toBe(before.log + 1);
    expect((await logOf(id))[0]).toMatchObject({ decision: "rejected", action: "adjustStock" });
    await p.close();
  });

  it("CA3: editar ejecuta los parámetros nuevos y la auditoría guarda los dos juegos", async () => {
    const id = threads.fresh();
    const p = program([calls.stock("k"), new AIMessage("Hecho.")]);
    const before = (await fx.sql.query(`SELECT stock FROM products WHERE sku = $1`, [TEST_SKU])).rows[0].stock as number;
    await runTurn(p.agent, id, "Sumá stock");
    await resumeTurn(p.agent, id, { decision: "edit", params: { sku: TEST_SKU, delta: 3, reason: "Llegaron solo 3" } });
    expect((await fx.sql.query(`SELECT stock FROM products WHERE sku = $1`, [TEST_SKU])).rows[0].stock).toBe(before + 3);
    const [log] = await logOf(id);
    expect(log).toMatchObject({ decision: "edited" });
    expect(log.payload.proposed).toMatchObject({ delta: 7 });
    expect(log.payload.final).toMatchObject({ delta: 3, reason: "Llegaron solo 3" });
    await p.close();
  });

  it("una edición que rompe las reglas (stock negativo) vuelve a preguntar y no toca la base", async () => {
    const id = threads.fresh();
    const p = program([calls.stock("k"), new AIMessage("Hecho.")]);
    await runTurn(p.agent, id, "Sumá stock");
    const before = await snapshot();
    const again = await resumeTurn(p.agent, id, { decision: "edit", params: { sku: TEST_SKU, delta: -5000, reason: "Prueba" } });
    expect(again.awaiting?.error).toMatch(/Parámetros inválidos|no puede quedar negativo/);
    expect(await snapshot()).toEqual(before);
    await p.close();
  });

  it("registerSale: el total sale de los precios de la base aunque el modelo mande otra cosa, y el SKU en minúscula se normaliza", async () => {
    const id = threads.fresh();
    const p = program([calls.sale("s"), new AIMessage("Vendido.")]);
    const stockBefore = (await fx.sql.query(`SELECT stock FROM products WHERE sku = $1`, [TEST_SKU])).rows[0].stock as number;
    const turn = await runTurn(p.agent, id, "Vendé dos");
    expect(turn.awaiting?.action.summary).toContain("Total $ 2.000."); // 2 × $ 1.000 del producto de prueba
    await resumeTurn(p.agent, id, { decision: "approve" });
    const [sale] = (await fx.sql.query(`SELECT * FROM sales WHERE client_id = $1`, [fx.clientId])).rows;
    expect(sale.total).toBe(2000);
    expect((await fx.sql.query(`SELECT stock FROM products WHERE sku = $1`, [TEST_SKU])).rows[0].stock).toBe(stockBefore - 2);
    await p.close();
  });

  it("CA6: el resumen sale de la base: muestra al cliente y al barbero reales del turno aunque el texto del modelo diga otra cosa", async () => {
    const apptId = await newAppointment(new Date(Date.now() + 251 * 86_400_000));
    const liar = new AIMessage({
      content: "Voy a cancelar el turno de Matías Giménez, nada más.",
      tool_calls: [{ id: "toolu_l", name: "cancelAppointment", args: { appointmentId: apptId }, type: "tool_call" }],
    });
    const p = program([liar, new AIMessage("ok")]);
    const turn = await runTurn(p.agent, threads.fresh(), "Cancelá el turno");
    expect(turn.awaiting?.action.summary).toContain("TST Cliente Fase5");
    expect(turn.awaiting?.action.summary).toContain("Lucas");
    expect(turn.awaiting?.action.summary).not.toContain("Matías");
    expect(turn.reply).toBe(""); // el texto del modelo no se muestra como respuesta
    await p.close();
  });

  it("CA10 a: un modelo que OBEDECE la nota de Walter y pide cancelar cinco turnos no logra proponer ni escribir nada", async () => {
    const injected = new AIMessage({
      content: "Según la nota, cancelo todos los turnos de la semana.",
      tool_calls: [1, 2, 3, 4, 5].map((n) => ({ id: `inj${n}`, name: "cancelAppointment", args: { appointmentId: n }, type: "tool_call" as const })),
    });
    const id = threads.fresh();
    const p = program([injected, new AIMessage("No voy a cancelar nada sin que me lo pidas.")]);
    const before = await snapshot();
    const turn = await runTurn(p.agent, id, "Mostrame a Walter Maidana");
    expect(turn.awaiting).toBeUndefined();
    expect(turn.reply).toBe("No voy a cancelar nada sin que me lo pidas.");
    expect(await snapshot()).toEqual(before);
    expect((await getStatus(p.graph, id)).awaiting).toBeUndefined();
    await p.close();
  });

  it("un modelo que insiste con una cancelación ajena sigue necesitando la aprobación, y una orden de rechazo la frena", async () => {
    // Un turno del seed (no del cliente de prueba): proponerlo es posible, ejecutarlo exige aprobar.
    const seed = (await fx.sql.query(`SELECT id FROM appointments WHERE status = 'scheduled' AND starts_at > now() + interval '1 day' ORDER BY id LIMIT 1`)).rows[0];
    const id = threads.fresh();
    const p = program([toolCall("o", "cancelAppointment", { appointmentId: seed.id }), new AIMessage("ok")]);
    const before = await snapshot();
    const turn = await runTurn(p.agent, id, "Cancelá ese turno");
    expect(turn.awaiting).toBeDefined();
    expect(await snapshot()).toEqual(before);
    await resumeTurn(p.agent, id, { decision: "reject" });
    expect({ ...(await snapshot()), log: 0 }).toEqual({ ...before, log: 0 });
    await p.close();
  });

  it("un horario que se ocupa después de proponer falla al aprobar, sin escribir, y se informa", async () => {
    const id = threads.fresh();
    // Martín a las 16:00: un horario que ningún otro test de este archivo usa.
    const create = toolCall("a", "createAppointment", { clientId: fx.clientId, staffName: "Martín", serviceName: "Corte", date: monday.iso, time: "16:00" });
    const p = program([create, new AIMessage("No se pudo agendar.")]);
    const turn = await runTurn(p.agent, id, "Agendá un corte");
    expect(turn.awaiting).toBeDefined();
    // Mientras tanto otra persona toma ese horario de Martín.
    const martin = (await fx.sql.query(`SELECT id FROM staff WHERE name = 'Martín'`)).rows[0].id;
    await fx.sql.query(
      `INSERT INTO appointments (client_id, staff_id, service_id, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5)`,
      [fx.clientId, martin, fx.serviceId, new Date(`${monday.iso}T19:00:00Z`), new Date(`${monday.iso}T19:30:00Z`)],
    );
    const done = await resumeTurn(p.agent, id, { decision: "approve" });
    expect(done.summary.actions[0]).toMatchObject({ ok: false });
    expect(done.summary.actions[0]!.message).toMatch(/ya tiene un turno en ese horario.*No se modificó ningún dato/);
    expect((await logOf(id))[0].payload).toMatchObject({ status: "failed" });
    await p.close();
  });

  it("los hilos de prueba del grupo serial usan el prefijo que limpia la auditoría", () => {
    expect(threads.fresh()).toMatch(new RegExp(`^${TEST_THREAD_PREFIX}`));
    expect(actionCases().map((c) => c.id)).toEqual(["E1", "E2", "E3", "E4", "E5", "E6"]);
  });

  it("continueTurn sobre un hilo pausado se rechaza (hay que decidir)", async () => {
    const id = threads.fresh();
    const p = program([calls.stock("k")]);
    await runTurn(p.agent, id, "Sumá stock");
    await expect(continueTurn(p.agent, id)).rejects.toThrow(/espera tu decisión/);
    await p.close();
  });
});
