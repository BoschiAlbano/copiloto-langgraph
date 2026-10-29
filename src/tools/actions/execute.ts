import type { Db } from "../../db/client.js";
import type { Prisma } from "../../db/generated/client.js";
import { describeMoment, formatLocal } from "../dates.js";
import { ToolUserError } from "../safe.js";
import { checkAppointmentSlot, money, resolveByName } from "./rules.js";
import { ACTION_SCHEMAS, type ActionName, type ActionParams, type Risk } from "./schemas.js";

// `execute`: aplica una acción YA APROBADA. Solo lo llama el nodo `execute_action`, con el cliente del rol
// copilot_actions (el único con permiso de escritura). Cada ejecución es UNA transacción que hace el efecto
// y escribe la fila de auditoría; si algo falla, no queda ni lo uno ni lo otro.
//
// Una acción se ejecuta una sola vez: la fila de auditoría lleva el id de la acción y un índice único
// impide repetirlo. Un reintento (por ejemplo, tras un corte entre la base y el checkpoint) devuelve el
// resultado ya registrado en vez de repetir el efecto.

export type Decision = "approved" | "edited" | "rejected";

export interface ExecuteInput {
  threadId: string;
  /** Único por acción propuesta: hilo + id de la llamada a herramienta. */
  actionId: string;
  tool: ActionName;
  /** Lo que se le mostró a la persona. */
  proposed: Record<string, unknown>;
  /** Lo que se ejecuta: igual a `proposed` si se aprobó; los parámetros nuevos si se editó. */
  params: Record<string, unknown>;
  summary: string;
  risk: Risk;
  decision: Decision;
  comment?: string;
}

export interface ExecutionOutcome {
  status: "executed" | "rejected" | "failed" | "already_done";
  /** Texto armado por el código para la persona y para el modelo. */
  message: string;
  result?: Record<string, unknown>;
}

class ActionFailure extends ToolUserError {}

type Tx = Prisma.TransactionClient;
type Applied = { result: Record<string, unknown>; message: string };
type Apply<T extends ActionName> = (tx: Tx, params: ActionParams<T>, now: Date) => Promise<Applied>;

const applyCreateAppointment: Apply<"createAppointment"> = async (tx, p, now) => {
  const staff = resolveByName(await tx.staff.findMany({ where: { active: true }, select: { id: true, name: true } }), p.staffName, "barbero");
  const service = resolveByName(await tx.service.findMany({ select: { id: true, name: true, durationMin: true } }), p.serviceName, "servicio");
  const { startsAt, endsAt } = checkAppointmentSlot(p.date, p.time, service.durationMin, service.name, now);
  // La restricción de exclusión de la base impide el solapamiento aunque otro turno se haya agendado después de proponer.
  const created = await tx.appointment.create({
    data: { clientId: p.clientId, staffId: staff.id, serviceId: service.id, startsAt, endsAt },
    select: { id: true },
  });
  return {
    result: { appointmentId: created.id, staff: staff.name, service: service.name, startsAt: formatLocal(startsAt), endsAt: formatLocal(endsAt) },
    message: `Turno #${created.id} agendado: ${service.name} con ${staff.name}, ${describeMoment(startsAt)}.`,
  };
};

const applyCancelAppointment: Apply<"cancelAppointment"> = async (tx, p, now) => {
  // UPDATE condicional: solo cancela si sigue agendado y es futuro, aunque haya cambiado desde la propuesta.
  const { count } = await tx.appointment.updateMany({
    where: { id: p.appointmentId, status: "scheduled", startsAt: { gt: now } },
    data: { status: "cancelled" },
  });
  if (count === 0) throw new ActionFailure(`El turno #${p.appointmentId} ya no se puede cancelar: no está agendado o ya pasó.`);
  return { result: { appointmentId: p.appointmentId }, message: `Turno #${p.appointmentId} cancelado.` };
};

const applyRegisterSale: Apply<"registerSale"> = async (tx, p) => {
  const services = await tx.service.findMany({ select: { id: true, name: true, price: true } });
  const skus = p.items.flatMap((i) => ("sku" in i ? [i.sku] : []));
  const products = await tx.product.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true, name: true, price: true } });

  let total = 0;
  const lines: Array<{ productId?: number; serviceId?: number; qty: number; unitPrice: number }> = [];
  for (const item of p.items) {
    if ("sku" in item) {
      const product = products.find((x) => x.sku === item.sku);
      if (!product) throw new ActionFailure(`El producto ${item.sku} ya no existe.`);
      // Descuento de stock condicional: si alguien vendió antes, no alcanza y toda la venta se deshace.
      const { count } = await tx.product.updateMany({
        where: { id: product.id, stock: { gte: item.qty } },
        data: { stock: { decrement: item.qty } },
      });
      if (count === 0) throw new ActionFailure(`No alcanza el stock de ${product.name} (${product.sku}) para ${item.qty} unidad(es).`);
      total += product.price * item.qty;
      lines.push({ productId: product.id, qty: item.qty, unitPrice: product.price });
    } else {
      const service = resolveByName(services, item.serviceName, "servicio");
      total += service.price * item.qty;
      lines.push({ serviceId: service.id, qty: item.qty, unitPrice: service.price });
    }
  }
  const sale = await tx.sale.create({
    data: { clientId: p.clientId ?? null, total, paymentMethod: p.paymentMethod, items: { create: lines } },
    select: { id: true },
  });
  return { result: { saleId: sale.id, total, items: lines.length }, message: `Venta #${sale.id} registrada por ${money(total)}.` };
};

const applyAdjustStock: Apply<"adjustStock"> = async (tx, p) => {
  const before = await tx.product.findUnique({ where: { sku: p.sku }, select: { name: true, stock: true } });
  if (!before) throw new ActionFailure(`El producto ${p.sku} ya no existe.`);
  const { count } = await tx.product.updateMany({
    where: { sku: p.sku, stock: { gte: p.delta < 0 ? -p.delta : 0 } },
    data: { stock: { increment: p.delta } },
  });
  if (count === 0) throw new ActionFailure(`El stock de ${before.name} (${p.sku}) no puede quedar negativo.`);
  const after = await tx.product.findUniqueOrThrow({ where: { sku: p.sku }, select: { stock: true } });
  return {
    result: { sku: p.sku, delta: p.delta, after: after.stock },
    message: `Stock de ${before.name} (${p.sku}) ajustado ${p.delta > 0 ? "+" : ""}${p.delta}: ahora hay ${after.stock}.`,
  };
};

const APPLY: { [T in ActionName]: Apply<T> } = {
  createAppointment: applyCreateAppointment,
  cancelAppointment: applyCancelAppointment,
  registerSale: applyRegisterSale,
  adjustStock: applyAdjustStock,
};

/** Código SQLSTATE de un error de la base, venga como venga envuelto por Prisma. */
export function sqlState(error: unknown): string | undefined {
  const e = error as {
    code?: string;
    meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } };
    cause?: { originalCode?: string; code?: string };
  };
  return e.meta?.driverAdapterError?.cause?.originalCode ?? e.meta?.code ?? e.cause?.originalCode ?? e.cause?.code ?? e.code;
}

const isUniqueViolation = (error: unknown) => ["23505", "P2002"].includes(sqlState(error) ?? "");

/** Errores esperables (reglas del negocio y restricciones de la base) como texto; cualquier otro se propaga. */
function failureMessage(error: unknown): string | undefined {
  if (error instanceof ToolUserError) return error.message;
  switch (sqlState(error)) {
    case "23P01":
      return "El barbero ya tiene un turno en ese horario.";
    case "23514":
      return "La base rechazó el cambio por una regla de datos (por ejemplo, un stock negativo).";
    case "23503":
    case "P2003":
      return "Un dato al que se referencia ya no existe (cliente, producto o servicio).";
    default:
      return undefined;
  }
}

function auditRow(input: ExecuteInput, now: Date, extra: Record<string, unknown>) {
  return {
    threadId: input.threadId,
    action: input.tool,
    decision: input.decision,
    decidedAt: now,
    payload: {
      actionId: input.actionId,
      proposed: input.proposed,
      final: input.decision === "rejected" ? null : input.params,
      summary: input.summary,
      risk: input.risk,
      ...(input.comment && { comment: input.comment }),
      ...extra,
    } as Prisma.InputJsonObject,
  };
}

async function alreadyRecorded(db: Db, actionId: string): Promise<ExecutionOutcome> {
  const row = await db.actionLog.findFirst({ where: { payload: { path: ["actionId"], equals: actionId } } });
  const payload = (row?.payload ?? {}) as { message?: string; result?: Record<string, unknown> };
  return {
    status: "already_done",
    message: `${payload.message ?? "La acción ya estaba registrada."} (ya estaba registrada: no se repitió)`,
    result: payload.result,
  };
}

/**
 * Registra la decisión y, si se aprobó, aplica la acción. Devuelve siempre un texto para la persona y el modelo.
 * Ante una regla del negocio que ya no se cumple (el turno cambió, se acabó el stock) no se modifica nada y se
 * informa; ante una caída de la base el error se propaga y el turno queda a medias, listo para `continueTurn`.
 */
export async function executeAction(db: Db, input: ExecuteInput, now: Date = new Date()): Promise<ExecutionOutcome> {
  if (input.decision === "rejected") {
    const message = `La persona rechazó la acción${input.comment ? ` (${input.comment})` : ""}. No se modificó ningún dato.`;
    try {
      await db.actionLog.create({ data: auditRow(input, now, { status: "rejected", message }) });
    } catch (error) {
      if (isUniqueViolation(error)) return alreadyRecorded(db, input.actionId);
      throw error;
    }
    return { status: "rejected", message };
  }

  try {
    return await db.$transaction(async (tx) => {
      const params = ACTION_SCHEMAS[input.tool].parse(input.params);
      const { result, message } = await (APPLY[input.tool] as Apply<ActionName>)(tx, params as never, now);
      // Si el id de la acción ya estaba registrado, esto falla y TODA la transacción (el efecto también) se deshace.
      await tx.actionLog.create({ data: auditRow(input, now, { status: "executed", result, message }) });
      return { status: "executed" as const, message, result };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return alreadyRecorded(db, input.actionId);
    const reason = failureMessage(error);
    if (reason === undefined) throw error;
    const message = `No se pudo ejecutar la acción: ${reason} No se modificó ningún dato.`;
    try {
      await db.actionLog.create({ data: auditRow(input, now, { status: "failed", error: reason, message }) });
    } catch (logError) {
      if (isUniqueViolation(logError)) return alreadyRecorded(db, input.actionId);
      throw logError;
    }
    return { status: "failed", message };
  }
}
