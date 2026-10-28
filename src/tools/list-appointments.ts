import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { daysInRange, formatLocal, localDateSchema, localDayRangeUtc } from "./dates.js";
import { safeTool, ToolUserError } from "./safe.js";
import { normalize } from "./text.js";

export const MAX_APPOINTMENTS = 50;
export const MAX_RANGE_DAYS = 31;

export const listAppointmentsInput = z
  .strictObject({
    dateFrom: localDateSchema.describe("Primer día, formato YYYY-MM-DD (hora de Argentina)"),
    dateTo: localDateSchema.describe("Último día incluido, formato YYYY-MM-DD. Para un solo día, igual a dateFrom"),
    staffName: z.string().trim().min(1).max(60).optional().describe("Nombre del barbero (opcional)"),
    clientId: z.number().int().positive().optional().describe("Id de un cliente, obtenido con findClient (opcional)"),
    status: z.enum(["scheduled", "done", "cancelled", "no_show"]).optional().describe("Estado del turno (opcional)"),
  })
  .refine((v) => v.dateFrom <= v.dateTo, { message: "dateFrom no puede ser posterior a dateTo" })
  .refine((v) => v.dateFrom > v.dateTo || daysInRange(v.dateFrom, v.dateTo) <= MAX_RANGE_DAYS, {
    message: `El rango no puede superar ${MAX_RANGE_DAYS} días`,
  });

export async function listAppointments(
  db: Db,
  input: z.input<typeof listAppointmentsInput>,
  options: { limit?: number } = {},
) {
  const { dateFrom, dateTo, staffName, clientId, status } = listAppointmentsInput.parse(input);
  const limit = options.limit ?? MAX_APPOINTMENTS;
  const { from, toExclusive } = localDayRangeUtc(dateFrom, dateTo);

  let staffIds: number[] | undefined;
  if (staffName) {
    const allStaff = await db.staff.findMany({ select: { id: true, name: true } });
    const wanted = normalize(staffName);
    const matches = allStaff.filter((s) => normalize(s.name).includes(wanted));
    if (matches.length === 0) {
      throw new ToolUserError(
        `No hay ningún barbero que coincida con "${staffName}". Barberos: ${allStaff.map((s) => s.name).join(", ")}.`,
      );
    }
    staffIds = matches.map((s) => s.id);
  }

  const where = {
    startsAt: { gte: from, lt: toExclusive },
    ...(staffIds && { staffId: { in: staffIds } }),
    ...(clientId && { clientId }),
    ...(status && { status }),
  };

  const [rows, byStatus] = await Promise.all([
    db.appointment.findMany({
      where,
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: limit,
      include: {
        client: { select: { id: true, name: true } },
        staff: { select: { name: true } },
        service: { select: { name: true } },
      },
    }),
    db.appointment.groupBy({ by: ["status"], where, _count: { _all: true } }),
  ]);

  const countByStatus = Object.fromEntries(byStatus.map((g) => [g.status, g._count._all]));
  const total = byStatus.reduce((sum, g) => sum + g._count._all, 0);

  return {
    total,
    activeCount: total - (countByStatus.cancelled ?? 0),
    countByStatus,
    truncated: total > rows.length,
    appointments: rows.map((a) => ({
      id: a.id,
      client: a.client,
      staff: a.staff.name,
      service: a.service.name,
      startsAt: formatLocal(a.startsAt),
      endsAt: formatLocal(a.endsAt),
      status: a.status,
    })),
  };
}

export const makeListAppointmentsTool = (db: Db) =>
  tool(safeTool("listAppointments", (input: z.input<typeof listAppointmentsInput>) => listAppointments(db, input)), {
    name: "listAppointments",
    description:
      "Lista turnos entre dos fechas (hora de Argentina, ambas incluidas, hasta 31 días), ordenados por horario. " +
      "Podés filtrar por barbero, cliente o estado. Devuelve `total` exacto, `activeCount` (turnos no cancelados), " +
      `\`countByStatus\` (cantidad por estado) y hasta ${MAX_APPOINTMENTS} turnos. Sin filtro de estado incluye todos, ` +
      "también los cancelados. Para cantidades usá estos campos, no cuentes las filas.",
    schema: listAppointmentsInput,
  });
