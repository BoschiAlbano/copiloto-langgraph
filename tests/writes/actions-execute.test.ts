import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrisma, type Db } from "../../src/db/client.js";
import { executeAction, type ExecuteInput } from "../../src/tools/actions/execute.js";
import { ACTION_SCHEMAS } from "../../src/tools/actions/schemas.js";
import { actionsUrl, farFuture, hasWriteDb, TEST_SKU, TEST_THREAD_PREFIX, useWriteFixtures } from "./fixtures.js";

// Ejecución de acciones aprobadas con el rol copilot_actions y datos de prueba propios.
describe.skipIf(!hasWriteDb)("executeAction", () => {
  const fx = useWriteFixtures();
  let db: Db;
  beforeAll(() => {
    db = createPrisma(actionsUrl!);
  });
  afterAll(() => db.$disconnect());

  let counter = 0;
  /** Una acción ya decidida; cada llamada usa un id nuevo salvo que se pase `actionId`. */
  const input = (tool: ExecuteInput["tool"], params: Record<string, unknown>, extra: Partial<ExecuteInput> = {}): ExecuteInput => {
    const threadId = `${TEST_THREAD_PREFIX}exec-${++counter}`;
    return {
      threadId,
      actionId: `${threadId}:call-1`,
      tool,
      proposed: params,
      params,
      summary: `Resumen de ${tool}`,
      risk: "medium",
      decision: "approved",
      ...extra,
    };
  };

  const rows = async (sql: string, params: unknown[] = []) => (await fx.sql.query(sql, params)).rows;
  const logOf = (actionId: string) => rows(`SELECT * FROM action_log WHERE payload->>'actionId' = $1`, [actionId]);
  const stock = async (sku = TEST_SKU) => (await rows(`SELECT stock FROM products WHERE sku = $1`, [sku]))[0].stock as number;
  const appointmentsOfFixture = async () =>
    rows(`SELECT * FROM appointments WHERE client_id = $1 ORDER BY id`, [fx.clientId]);

  /** Un lunes a ~30 semanas, a la hora indicada: lejos de la agenda sembrada. */
  const slot = (time: string) => {
    const d = farFuture(210);
    const date = new Date(d.getTime() + ((8 - d.getUTCDay()) % 7) * 86_400_000).toISOString().slice(0, 10);
    return { date, time };
  };

  describe("createAppointment", () => {
    it("agenda el turno con la hora de fin correcta y deja la fila de auditoría", async () => {
      const call = input("createAppointment", { clientId: fx.clientId, staffName: "Lucas", serviceName: "Corte", ...slot("11:00") });
      const before = Date.now();
      const out = await executeAction(db, call);

      expect(out.status).toBe("executed");
      expect(out.message).toMatch(/^Turno #\d+ agendado: Corte con Lucas/);
      const [appointment] = await appointmentsOfFixture();
      expect(appointment.status).toBe("scheduled");
      expect(appointment.staff_id).toBe(fx.staffId);
      expect(new Date(appointment.ends_at).getTime() - new Date(appointment.starts_at).getTime()).toBe(30 * 60_000);
      expect(new Date(appointment.starts_at).toISOString()).toBe(`${call.params.date}T14:00:00.000Z`); // 11:00 en Argentina = 14:00 UTC

      const [log] = await logOf(call.actionId);
      expect(log).toMatchObject({ thread_id: call.threadId, action: "createAppointment", decision: "approved" });
      expect(log.decided_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(log.payload).toMatchObject({ actionId: call.actionId, status: "executed", result: { appointmentId: appointment.id } });
    });

    it("ejecutar dos veces la misma acción produce un solo turno y una sola fila", async () => {
      const call = input("createAppointment", { clientId: fx.clientId, staffName: "Lucas", serviceName: "Barba", ...slot("12:00") });
      const first = await executeAction(db, call);
      const again = await executeAction(db, call);
      expect(first.status).toBe("executed");
      expect(again.status).toBe("already_done");
      expect(again.message).toContain("ya estaba registrada");
      expect(await rows(`SELECT 1 FROM appointments WHERE client_id = $1 AND starts_at = $2`, [fx.clientId, new Date(`${call.params.date}T15:00:00Z`)])).toHaveLength(1);
      expect(await logOf(call.actionId)).toHaveLength(1);
    });

    it("dos ejecuciones simultáneas de la misma acción producen un solo efecto", async () => {
      const call = input("createAppointment", { clientId: fx.clientId, staffName: "Martín", serviceName: "Corte", ...slot("13:00") });
      const outcomes = await Promise.all([executeAction(db, call), executeAction(db, call), executeAction(db, call)]);
      expect(outcomes.map((o) => o.status).sort()).toEqual(["already_done", "already_done", "executed"]);
      expect(await logOf(call.actionId)).toHaveLength(1);
      expect(await rows(`SELECT 1 FROM appointments WHERE client_id = $1 AND starts_at = $2`, [fx.clientId, new Date(`${call.params.date}T16:00:00Z`)])).toHaveLength(1);
    });

    it("un horario ocupado después de proponer se rechaza sin ensuciar la base (la restricción de la base lo impide)", async () => {
      const when = slot("16:00");
      await executeAction(db, input("createAppointment", { clientId: fx.clientId, staffName: "Nicolás", serviceName: "Corte", ...when }));
      const clash = input("createAppointment", { clientId: fx.clientId, staffName: "Nicolás", serviceName: "Barba", ...slot("16:15") });
      const out = await executeAction(db, clash);
      expect(out.status).toBe("failed");
      expect(out.message).toMatch(/ya tiene un turno en ese horario.*No se modificó ningún dato/);
      expect(await rows(`SELECT 1 FROM appointments WHERE client_id = $1 AND starts_at = $2`, [fx.clientId, new Date(`${when.date}T19:15:00Z`)])).toHaveLength(0);
      const [log] = await logOf(clash.actionId);
      expect(log.decision).toBe("approved");
      expect(log.payload).toMatchObject({ status: "failed" });
    });

    it("re-comprueba el horario al ejecutar: un turno que ya pasó no se agenda", async () => {
      const call = input("createAppointment", { clientId: fx.clientId, staffName: "Lucas", serviceName: "Corte", ...slot("18:00") });
      const out = await executeAction(db, call, new Date(Date.now() + 400 * 86_400_000));
      expect(out.status).toBe("failed");
      expect(out.message).toContain("ya pasó");
      expect(await rows(`SELECT 1 FROM appointments WHERE client_id = $1 AND starts_at = $2`, [fx.clientId, new Date(`${call.params.date}T21:00:00Z`)])).toHaveLength(0);
    });
  });

  describe("cancelAppointment", () => {
    const insertAppointment = async (startsAt: Date, status = "scheduled") =>
      (
        await fx.sql.query(
          `INSERT INTO appointments (client_id, staff_id, service_id, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [fx.clientId, fx.staffId, fx.serviceId, startsAt, new Date(startsAt.getTime() + 30 * 60_000), status],
        )
      ).rows[0].id as number;

    it("cambia solo el estado a cancelled y no borra el turno", async () => {
      const id = await insertAppointment(farFuture(300, 10 * 60));
      const call = input("cancelAppointment", { appointmentId: id, reason: "Se enfermó" });
      const out = await executeAction(db, call);
      expect(out).toMatchObject({ status: "executed", message: `Turno #${id} cancelado.` });
      const [appointment] = await rows(`SELECT status FROM appointments WHERE id = $1`, [id]);
      expect(appointment.status).toBe("cancelled");
      expect((await logOf(call.actionId))[0].payload).toMatchObject({ final: { appointmentId: id, reason: "Se enfermó" } });
    });

    it("no cancela lo que ya no está agendado o ya pasó", async () => {
      const cancelled = await insertAppointment(farFuture(301, 10 * 60), "cancelled");
      const past = await insertAppointment(new Date(Date.now() - 800 * 86_400_000)); // mucho antes de cualquier turno sembrado
      for (const id of [cancelled, past]) {
        const out = await executeAction(db, input("cancelAppointment", { appointmentId: id }));
        expect(out.status).toBe("failed");
        expect(out.message).toContain("ya no se puede cancelar");
      }
      expect((await rows(`SELECT status FROM appointments WHERE id = $1`, [past]))[0].status).toBe("scheduled");
    });
  });

  describe("registerSale", () => {
    it("calcula el total con los precios de la base, descuenta stock y guarda los renglones", async () => {
      const before = await stock();
      const call = input("registerSale", {
        clientId: fx.clientId,
        paymentMethod: "cash",
        items: [{ sku: TEST_SKU, qty: 3 }, { serviceName: "Corte", qty: 1 }],
      });
      const out = await executeAction(db, call);
      expect(out.status).toBe("executed");

      const [sale] = await rows(`SELECT * FROM sales WHERE id = $1`, [out.result!.saleId]);
      const servicePrice = (await rows(`SELECT price FROM services WHERE name = 'Corte'`))[0].price as number;
      expect(sale).toMatchObject({ client_id: fx.clientId, payment_method: "cash", total: 3 * 1000 + servicePrice });
      const items = await rows(`SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id`, [sale.id]);
      expect(items.map((i) => [i.qty, i.unit_price, i.product_id !== null, i.service_id !== null])).toEqual([
        [3, 1000, true, false],
        [1, servicePrice, false, true],
      ]);
      expect(await stock()).toBe(before - 3);
      expect((await logOf(call.actionId))[0].payload.result).toMatchObject({ saleId: sale.id, total: sale.total });
    });

    it("es todo o nada: si un renglón no tiene stock, no se descuenta nada ni se crea la venta", async () => {
      await fx.sql.query(`INSERT INTO products (name, sku, price, stock, min_stock) VALUES ('TST Escaso', 'TST-002', 500, 1, 0)`);
      const before = await stock();
      const salesBefore = (await rows(`SELECT COUNT(*)::int AS n FROM sales WHERE client_id = $1`, [fx.clientId]))[0].n;
      const out = await executeAction(
        db,
        input("registerSale", { clientId: fx.clientId, paymentMethod: "card", items: [{ sku: TEST_SKU, qty: 2 }, { sku: "TST-002", qty: 5 }] }),
      );
      expect(out.status).toBe("failed");
      expect(out.message).toMatch(/No alcanza el stock de TST Escaso/);
      expect(await stock()).toBe(before);
      expect((await rows(`SELECT COUNT(*)::int AS n FROM sales WHERE client_id = $1`, [fx.clientId]))[0].n).toBe(salesBefore);
    });
  });

  describe("adjustStock", () => {
    it("suma y resta unidades, y no deja el stock en negativo", async () => {
      const before = await stock();
      const add = await executeAction(db, input("adjustStock", { sku: TEST_SKU, delta: 5, reason: "Llegó un pedido" }));
      expect(add).toMatchObject({ status: "executed", result: { sku: TEST_SKU, delta: 5, after: before + 5 } });
      expect(await stock()).toBe(before + 5);

      const sub = await executeAction(db, input("adjustStock", { sku: TEST_SKU, delta: -2, reason: "Rotura" }));
      expect(sub.status).toBe("executed");
      expect(await stock()).toBe(before + 3);

      const tooMuch = await executeAction(db, input("adjustStock", { sku: TEST_SKU, delta: -(before + 4), reason: "Error de carga" }));
      expect(tooMuch.status).toBe("failed");
      expect(tooMuch.message).toMatch(/no puede quedar negativo/);
      expect(await stock()).toBe(before + 3);
    });
  });

  describe("rechazar y editar", () => {
    it("rechazar no modifica nada y deja una fila rejected con el comentario", async () => {
      const before = await stock();
      const call = input("adjustStock", { sku: TEST_SKU, delta: 10, reason: "Prueba" }, { decision: "rejected", comment: "Esperá al conteo" });
      const out = await executeAction(db, call);
      expect(out).toMatchObject({ status: "rejected" });
      expect(out.message).toContain("Esperá al conteo");
      expect(await stock()).toBe(before);
      const [log] = await logOf(call.actionId);
      expect(log).toMatchObject({ decision: "rejected", thread_id: call.threadId });
      expect(log.decided_at).toBeInstanceOf(Date);
      expect(log.payload).toMatchObject({ final: null, comment: "Esperá al conteo", status: "rejected" });
      expect((await executeAction(db, call)).status).toBe("already_done"); // tampoco se registra dos veces
      expect(await logOf(call.actionId)).toHaveLength(1);
    });

    it("editar ejecuta los parámetros nuevos y guarda los dos juegos de parámetros", async () => {
      const before = await stock();
      const proposed = { sku: TEST_SKU, delta: 10, reason: "Llegó un pedido" };
      const edited = { sku: TEST_SKU, delta: 4, reason: "Llegaron solo 4" };
      const call = input("adjustStock", edited, { proposed, decision: "edited" });
      const out = await executeAction(db, call);
      expect(out.status).toBe("executed");
      expect(await stock()).toBe(before + 4);
      const [log] = await logOf(call.actionId);
      expect(log.decision).toBe("edited");
      expect(log.payload).toMatchObject({ proposed, final: edited });
    });
  });

  it("parámetros mal formados no llegan a la base: se propaga el error y no queda nada", async () => {
    const before = await stock();
    const bad = input("adjustStock", { sku: TEST_SKU, delta: 5, reason: "Prueba", price: 1 });
    await expect(executeAction(db, bad)).rejects.toThrow();
    expect(await stock()).toBe(before);
    expect(await logOf(bad.actionId)).toHaveLength(0);
    expect(ACTION_SCHEMAS.adjustStock.safeParse(bad.params).success).toBe(false);
  });
});
