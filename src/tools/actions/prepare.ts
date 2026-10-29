import type { Db } from "../../db/client.js";
import { describeMoment, localDateTimeToUtc, localMinutesOfDay, localWeekday } from "../dates.js";
import { ToolUserError } from "../safe.js";
import {
  CLOSE_MINUTE,
  CLOSED_WEEKDAY,
  describeZodError,
  HIGH_RISK_STOCK_DELTA,
  money,
  OPEN_MINUTE,
  PAYMENT_LABELS,
  resolveByName,
  SLOT_MINUTES,
} from "./rules.js";
import { ACTION_SCHEMAS, type ActionName, type ActionParams, type PreparedAction } from "./schemas.js";

// `prepare`: valida una acción pedida por el modelo (o editada por la persona), la normaliza y arma el
// resumen que va a leer la persona. Solo LEE (rol copilot_reader): no modifica nada. Los errores son
// ToolUserError con un texto pensado para corregir los parámetros.

type Handler<T extends ActionName> = (db: Db, params: ActionParams<T>, now: Date) => Promise<PreparedAction>;

const prepareCreateAppointment: Handler<"createAppointment"> = async (db, p, now) => {
  const client = await db.client.findUnique({ where: { id: p.clientId }, select: { id: true, name: true } });
  if (!client) throw new ToolUserError(`No existe un cliente con id ${p.clientId}. Buscalo con findClient.`);

  const staff = resolveByName(await db.staff.findMany({ where: { active: true }, select: { id: true, name: true } }), p.staffName, "barbero");
  const service = resolveByName(
    await db.service.findMany({ select: { id: true, name: true, durationMin: true } }),
    p.serviceName,
    "servicio",
  );

  if (localWeekday(p.date) === CLOSED_WEEKDAY) throw new ToolUserError("La barbería no abre los domingos.");
  const startsAt = localDateTimeToUtc(p.date, p.time);
  const endsAt = new Date(startsAt.getTime() + service.durationMin * 60_000);
  const startMinute = localMinutesOfDay(startsAt);
  if (startMinute % SLOT_MINUTES !== 0) throw new ToolUserError(`Los turnos empiezan en múltiplos de ${SLOT_MINUTES} minutos (por ejemplo 15:00 o 15:15).`);
  if (startMinute < OPEN_MINUTE || startMinute + service.durationMin > CLOSE_MINUTE) {
    throw new ToolUserError(`Los turnos son entre las 10:00 y las 20:00, y ${service.name} dura ${service.durationMin} minutos: tiene que terminar antes del cierre.`);
  }
  if (startsAt.getTime() <= now.getTime()) throw new ToolUserError("Ese horario ya pasó. Elegí uno futuro.");

  const clash = await db.appointment.findFirst({
    where: { staffId: staff.id, status: { not: "cancelled" }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
    select: { startsAt: true, endsAt: true },
  });
  if (clash) {
    throw new ToolUserError(`${staff.name} ya tiene un turno de ${describeMoment(clash.startsAt).slice(-5)} a ${describeMoment(clash.endsAt).slice(-5)} ese día. Probá con otro horario o con otro barbero.`);
  }

  return {
    tool: "createAppointment",
    params: { clientId: client.id, staffName: staff.name, serviceName: service.name, date: p.date, time: p.time },
    risk: "low",
    summary: `Agendar ${service.name} (${service.durationMin} min) para ${client.name} con ${staff.name}: ${describeMoment(startsAt)} a ${describeMoment(endsAt).slice(-5)}.`,
  };
};

const prepareCancelAppointment: Handler<"cancelAppointment"> = async (db, p, now) => {
  const appointment = await db.appointment.findUnique({
    where: { id: p.appointmentId },
    include: { client: { select: { name: true } }, staff: { select: { name: true } }, service: { select: { name: true } } },
  });
  if (!appointment) throw new ToolUserError(`No existe un turno con id ${p.appointmentId}. Buscalo con listAppointments.`);
  if (appointment.status !== "scheduled") {
    throw new ToolUserError(`El turno ${appointment.id} no se puede cancelar: su estado es ${appointment.status}. Solo se cancelan turnos agendados.`);
  }
  if (appointment.startsAt.getTime() <= now.getTime()) throw new ToolUserError(`El turno ${appointment.id} ya pasó: no se puede cancelar.`);

  return {
    tool: "cancelAppointment",
    params: { appointmentId: appointment.id, ...(p.reason && { reason: p.reason }) },
    risk: "medium",
    summary:
      `Cancelar el turno #${appointment.id} de ${appointment.client.name}: ${appointment.service.name} con ${appointment.staff.name}, ` +
      `${describeMoment(appointment.startsAt)}.${p.reason ? ` Motivo: ${p.reason}.` : ""}`,
  };
};

const prepareRegisterSale: Handler<"registerSale"> = async (db, p) => {
  let clientName: string | undefined;
  if (p.clientId !== undefined) {
    const client = await db.client.findUnique({ where: { id: p.clientId }, select: { name: true } });
    if (!client) throw new ToolUserError(`No existe un cliente con id ${p.clientId}. Buscalo con findClient, o registrá la venta sin cliente.`);
    clientName = client.name;
  }

  const services = await db.service.findMany({ select: { id: true, name: true, price: true } });
  const wantedSkus = p.items.flatMap((i) => ("sku" in i ? [i.sku] : []));
  if (new Set(wantedSkus).size !== wantedSkus.length) throw new ToolUserError("Un producto aparece en más de un renglón: sumá las cantidades en uno solo.");
  const products = await db.product.findMany({ where: { sku: { in: wantedSkus } }, select: { sku: true, name: true, price: true, stock: true } });

  const lines: string[] = [];
  const normalizedItems: Array<{ sku: string; qty: number } | { serviceName: string; qty: number }> = [];
  let total = 0;
  const seenServices = new Set<string>();
  for (const item of p.items) {
    if ("sku" in item) {
      const product = products.find((x) => x.sku === item.sku);
      if (!product) throw new ToolUserError(`No existe un producto con SKU ${item.sku}. Consultá el stock con getStockLevels.`);
      if (product.stock < item.qty) throw new ToolUserError(`No alcanza el stock de ${product.name} (${product.sku}): hay ${product.stock} y se piden ${item.qty}.`);
      total += product.price * item.qty;
      lines.push(`${item.qty} × ${product.name} (${money(product.price)})`);
      normalizedItems.push({ sku: product.sku, qty: item.qty });
    } else {
      const service = resolveByName(services, item.serviceName, "servicio");
      if (seenServices.has(service.name)) throw new ToolUserError(`El servicio ${service.name} aparece en más de un renglón: sumá las cantidades en uno solo.`);
      seenServices.add(service.name);
      total += service.price * item.qty;
      lines.push(`${item.qty} × ${service.name} (${money(service.price)})`);
      normalizedItems.push({ serviceName: service.name, qty: item.qty });
    }
  }

  return {
    tool: "registerSale",
    params: { ...(p.clientId !== undefined && { clientId: p.clientId }), paymentMethod: p.paymentMethod, items: normalizedItems },
    risk: "medium",
    summary:
      `Registrar una venta ${clientName ? `a ${clientName}` : "sin cliente"}, pagada en ${PAYMENT_LABELS[p.paymentMethod]}: ` +
      `${lines.join("; ")}. Total ${money(total)}.`,
  };
};

const prepareAdjustStock: Handler<"adjustStock"> = async (db, p) => {
  const product = await db.product.findUnique({ where: { sku: p.sku }, select: { sku: true, name: true, stock: true } });
  if (!product) throw new ToolUserError(`No existe un producto con SKU ${p.sku}. Consultá el stock con getStockLevels.`);
  const after = product.stock + p.delta;
  if (after < 0) throw new ToolUserError(`El stock de ${product.name} (${product.sku}) no puede quedar negativo: hay ${product.stock} y el ajuste es ${p.delta}.`);

  return {
    tool: "adjustStock",
    params: { sku: product.sku, delta: p.delta, reason: p.reason },
    risk: Math.abs(p.delta) >= HIGH_RISK_STOCK_DELTA ? "high" : "medium",
    summary: `Ajustar el stock de ${product.name} (${product.sku}): ${p.delta > 0 ? "+" : ""}${p.delta}, de ${product.stock} a ${after}. Motivo: ${p.reason}.`,
  };
};

const HANDLERS: { [T in ActionName]: Handler<T> } = {
  createAppointment: prepareCreateAppointment,
  cancelAppointment: prepareCancelAppointment,
  registerSale: prepareRegisterSale,
  adjustStock: prepareAdjustStock,
};

/** Valida y normaliza una acción y arma lo que va a leer la persona. Lanza ToolUserError si no se puede. */
export async function prepareAction(db: Db, tool: ActionName, rawParams: unknown, now: Date = new Date()): Promise<PreparedAction> {
  const parsed = ACTION_SCHEMAS[tool].safeParse(rawParams);
  if (!parsed.success) throw new ToolUserError(`Parámetros inválidos para ${tool}: ${describeZodError(parsed.error)}.`);
  const handler = HANDLERS[tool] as Handler<ActionName>;
  return handler(db, parsed.data as never, now);
}
