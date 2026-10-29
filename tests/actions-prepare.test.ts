import { describe, expect, it } from "vitest";
import { mondayInThreeWeeks } from "../evals/action-cases.js";
import { prepareAction } from "../src/tools/actions/prepare.js";
import { formatLocal } from "../src/tools/dates.js";
import { ToolUserError } from "../src/tools/safe.js";
import { useDatabases, hasDb } from "./tools/helpers.js";

// `prepare` solo lee (rol copilot_reader). Requiere `npm run db:reset`.
describe.skipIf(!hasDb)("prepareAction", () => {
  const ctx = useDatabases();
  const monday = mondayInThreeWeeks(new Date());
  const prepare = (tool: Parameters<typeof prepareAction>[1], params: unknown, now?: Date) =>
    prepareAction(ctx.db, tool, params, now);
  const rejects = (tool: Parameters<typeof prepareAction>[1], params: unknown, message: RegExp, now?: Date) =>
    expect(prepare(tool, params, now)).rejects.toSatisfy((e: unknown) => e instanceof ToolUserError && message.test(e.message));

  const firstClient = async () => (await ctx.sql.query(`SELECT id, name FROM clients ORDER BY id LIMIT 1`)).rows[0] as { id: number; name: string };
  const futureAppointment = async () =>
    (
      await ctx.sql.query(
        `SELECT a.id, a.starts_at, c.name AS client, s.name AS staff
           FROM appointments a JOIN clients c ON c.id = a.client_id JOIN staff s ON s.id = a.staff_id
          WHERE a.status = 'scheduled' AND a.starts_at > now() + interval '1 hour' ORDER BY a.starts_at LIMIT 1`,
      )
    ).rows[0] as { id: number; starts_at: Date; client: string; staff: string };

  describe("createAppointment", () => {
    const base = async () => ({ clientId: (await firstClient()).id, staffName: "Lucas", serviceName: "Corte", date: monday.iso, time: "15:00" });

    it("normaliza los nombres y arma el resumen con el nombre real del cliente", async () => {
      const client = await firstClient();
      const prepared = await prepare("createAppointment", { ...(await base()), staffName: "lucas", serviceName: "corte" });
      expect(prepared).toMatchObject({
        tool: "createAppointment",
        risk: "low",
        params: { clientId: client.id, staffName: "Lucas", serviceName: "Corte", date: monday.iso, time: "15:00" },
      });
      expect(prepared.summary).toContain(client.name);
      expect(prepared.summary).toMatch(/Agendar Corte \(30 min\).*con Lucas.*15:00 a 15:30/);
    });

    it("un nombre parcial único alcanza; uno ambiguo pide aclarar", async () => {
      expect((await prepare("createAppointment", { ...(await base()), serviceName: "combo" })).params.serviceName).toBe("Combo corte + barba");
      await rejects("createAppointment", { ...(await base()), serviceName: "co" }, /más de un servicio/);
    });

    it("rechaza lo que el negocio no permite, con un mensaje que explica por qué", async () => {
      const b = await base();
      await rejects("createAppointment", { ...b, clientId: 999999 }, /No existe un cliente/);
      await rejects("createAppointment", { ...b, staffName: "Pedro" }, /No hay barbero.*Opciones: Martín, Lucas, Nicolás/);
      await rejects("createAppointment", { ...b, serviceName: "Masaje" }, /No hay servicio/);
      const sunday = mondayInThreeWeeks(new Date()).iso;
      const sundayDate = new Date(new Date(`${sunday}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
      await rejects("createAppointment", { ...b, date: sundayDate }, /domingos/);
      await rejects("createAppointment", { ...b, time: "09:45" }, /entre las 10:00 y las 20:00/);
      await rejects("createAppointment", { ...b, time: "19:45" }, /terminar antes del cierre/);
      await rejects("createAppointment", { ...b, serviceName: "Color", time: "19:00" }, /90 minutos/);
      await rejects("createAppointment", { ...b, time: "10:10" }, /múltiplos de 15/);
      await rejects("createAppointment", { ...b, date: "2020-01-06" }, /ya pasó/);
    });

    it("avisa si el barbero ya tiene un turno a esa hora", async () => {
      const taken = await futureAppointment();
      const local = formatLocal(taken.starts_at);
      await rejects(
        "createAppointment",
        { clientId: (await firstClient()).id, staffName: taken.staff, serviceName: "Corte", date: local.slice(0, 10), time: local.slice(11, 16) },
        /ya tiene un turno de/,
      );
    });

    it("usa el reloj recibido: lo que ya pasó para ese reloj se rechaza", async () => {
      await rejects("createAppointment", await base(), /ya pasó/, new Date(Date.now() + 365 * 86_400_000));
    });
  });

  describe("cancelAppointment", () => {
    it("arma el resumen con el cliente, el servicio y el barbero reales del turno", async () => {
      const a = await futureAppointment();
      const prepared = await prepare("cancelAppointment", { appointmentId: a.id, reason: "Se enfermó" });
      expect(prepared).toMatchObject({ tool: "cancelAppointment", risk: "medium", params: { appointmentId: a.id, reason: "Se enfermó" } });
      expect(prepared.summary).toContain(`#${a.id}`);
      expect(prepared.summary).toContain(a.client);
      expect(prepared.summary).toContain(a.staff);
      expect(prepared.summary).toContain("Motivo: Se enfermó");
    });

    it("rechaza turnos inexistentes, pasados o que no están agendados", async () => {
      await rejects("cancelAppointment", { appointmentId: 99999999 }, /No existe un turno/);
      const done = (await ctx.sql.query(`SELECT id FROM appointments WHERE status = 'done' LIMIT 1`)).rows[0];
      await rejects("cancelAppointment", { appointmentId: done.id }, /estado es done/);
      const past = (await ctx.sql.query(`SELECT id FROM appointments WHERE status = 'scheduled' AND starts_at < now() LIMIT 1`)).rows[0];
      if (past) await rejects("cancelAppointment", { appointmentId: past.id }, /ya pasó/);
      const a = await futureAppointment();
      await rejects("cancelAppointment", { appointmentId: a.id }, /ya pasó/, new Date(Date.now() + 365 * 86_400_000));
    });
  });

  describe("registerSale", () => {
    it("calcula el total con los precios de la base, no con lo que dice el modelo", async () => {
      const prepared = await prepare("registerSale", {
        paymentMethod: "cash",
        items: [{ sku: "cer-001", qty: 2 }, { serviceName: "corte", qty: 1 }],
      });
      expect(prepared.tool).toBe("registerSale");
      expect(prepared.risk).toBe("medium");
      expect(prepared.params).toEqual({ paymentMethod: "cash", items: [{ sku: "CER-001", qty: 2 }, { serviceName: "Corte", qty: 1 }] });
      expect(prepared.summary).toContain("sin cliente");
      expect(prepared.summary).toContain("efectivo");
      expect(prepared.summary).toContain("2 × Cera mate ($ 9.500)");
      expect(prepared.summary).toContain("Total $ 27.000."); // 2 × 9.500 + 8.000
    });

    it("incluye el cliente cuando se indica", async () => {
      const client = await firstClient();
      const prepared = await prepare("registerSale", { clientId: client.id, paymentMethod: "card", items: [{ sku: "GEL-001", qty: 1 }] });
      expect(prepared.summary).toContain(`a ${client.name}`);
      expect(prepared.params.clientId).toBe(client.id);
    });

    it("rechaza SKU o servicio inexistente, cliente inexistente, renglones repetidos y stock insuficiente", async () => {
      await rejects("registerSale", { paymentMethod: "cash", items: [{ sku: "ZZZ-999", qty: 1 }] }, /No existe un producto/);
      await rejects("registerSale", { paymentMethod: "cash", items: [{ serviceName: "Masaje", qty: 1 }] }, /No hay servicio/);
      await rejects("registerSale", { clientId: 999999, paymentMethod: "cash", items: [{ sku: "CER-001", qty: 1 }] }, /No existe un cliente/);
      await rejects("registerSale", { paymentMethod: "cash", items: [{ sku: "CER-001", qty: 1 }, { sku: "CER-001", qty: 1 }] }, /más de un renglón/);
      const low = (await ctx.sql.query(`SELECT sku, stock FROM products WHERE stock < 50 ORDER BY stock LIMIT 1`)).rows[0];
      await rejects("registerSale", { paymentMethod: "cash", items: [{ sku: low.sku, qty: 50 }] }, /No alcanza el stock/);
    });
  });

  describe("adjustStock", () => {
    it("muestra el stock antes y después", async () => {
      const p = (await ctx.sql.query(`SELECT sku, name, stock FROM products WHERE sku = 'SHA-001'`)).rows[0];
      const prepared = await prepare("adjustStock", { sku: "sha-001", delta: 20, reason: "Llegó un pedido" });
      expect(prepared).toMatchObject({ tool: "adjustStock", risk: "medium", params: { sku: "SHA-001", delta: 20, reason: "Llegó un pedido" } });
      expect(prepared.summary).toContain(`${p.name} (SHA-001): +20, de ${p.stock} a ${p.stock + 20}`);
    });

    it("marca como riesgo alto los ajustes grandes", async () => {
      expect((await prepare("adjustStock", { sku: "SHA-001", delta: 100, reason: "Inventario" })).risk).toBe("high");
      expect((await prepare("adjustStock", { sku: "SHA-001", delta: 99, reason: "Inventario" })).risk).toBe("medium");
    });

    it("no deja el stock en negativo ni ajusta productos inexistentes", async () => {
      const p = (await ctx.sql.query(`SELECT stock FROM products WHERE sku = 'SHA-001'`)).rows[0];
      await rejects("adjustStock", { sku: "SHA-001", delta: -(p.stock + 1), reason: "Prueba" }, /no puede quedar negativo/);
      await rejects("adjustStock", { sku: "ZZZ-999", delta: 1, reason: "Prueba" }, /No existe un producto/);
    });
  });

  it("los parámetros mal formados se informan como texto legible, sin tocar la base", async () => {
    await rejects("adjustStock", { sku: "SHA-001", delta: 0, reason: "Prueba" }, /Parámetros inválidos para adjustStock: delta: El ajuste no puede ser cero/);
    await rejects("adjustStock", { sku: "SHA-001", delta: 1, reason: "Prueba", extra: true }, /Parámetros inválidos/);
    await rejects("cancelAppointment", "no es un objeto", /Parámetros inválidos/);
  });
});
