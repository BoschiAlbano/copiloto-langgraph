import { z } from "zod";
import { localDateSchema } from "../dates.js";

// Parámetros de las cuatro acciones. Son estrictos (campos de más = error) y con límites. Los mismos
// esquemas validan lo que pide el modelo y lo que edita la persona.

const sku = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{3,20}$/, "El SKU son letras mayúsculas, números y guiones (por ejemplo CER-001)")
  .describe("SKU del producto, por ejemplo CER-001");
const name = (what: string) => z.string().trim().min(1).max(60).describe(what);
const qty = z.number().int().min(1).max(50).describe("Cantidad (1 a 50)");

export const createAppointmentInput = z.strictObject({
  clientId: z.number().int().positive().describe("Id del cliente, obtenido con findClient"),
  staffName: name("Nombre del barbero"),
  serviceName: name("Nombre del servicio (Corte, Barba, Combo corte + barba o Color)"),
  date: localDateSchema.describe("Día del turno, formato YYYY-MM-DD (hora de Argentina)"),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Usá el formato HH:mm")
    .describe("Hora de inicio, formato HH:mm, en múltiplos de 15 minutos"),
});

export const cancelAppointmentInput = z.strictObject({
  appointmentId: z.number().int().positive().describe("Id del turno, obtenido con listAppointments"),
  reason: z.string().trim().min(1).max(200).optional().describe("Motivo de la cancelación (opcional)"),
});

const saleItem = z.union([
  z.strictObject({ sku, qty }).describe("Un producto"),
  z.strictObject({ serviceName: name("Nombre del servicio"), qty }).describe("Un servicio"),
]);

export const registerSaleInput = z.strictObject({
  clientId: z.number().int().positive().optional().describe("Id del cliente (opcional: puede ser una venta sin cliente)"),
  paymentMethod: z.enum(["cash", "card", "transfer"]).describe("Medio de pago: cash (efectivo), card (tarjeta) o transfer"),
  items: z.array(saleItem).min(1).max(10).describe("Renglones de la venta. No incluyas precios ni total: los calcula el sistema"),
});

export const adjustStockInput = z.strictObject({
  sku,
  delta: z
    .number()
    .int()
    .min(-500)
    .max(500)
    .refine((v) => v !== 0, "El ajuste no puede ser cero")
    .describe("Unidades a sumar (positivo) o restar (negativo)"),
  reason: z.string().trim().min(3).max(200).describe("Motivo del ajuste"),
});

export const ACTION_SCHEMAS = {
  createAppointment: createAppointmentInput,
  cancelAppointment: cancelAppointmentInput,
  registerSale: registerSaleInput,
  adjustStock: adjustStockInput,
} as const;

export type ActionName = keyof typeof ACTION_SCHEMAS;
export const ACTION_NAMES = Object.keys(ACTION_SCHEMAS) as ActionName[];

export type ActionParams<T extends ActionName> = z.output<(typeof ACTION_SCHEMAS)[T]>;

export const isActionName = (value: string): value is ActionName => Object.hasOwn(ACTION_SCHEMAS, value);

export type Risk = "low" | "medium" | "high";

/** Una acción lista para mostrarse a la persona: lo que lee, armado por el código. */
export interface PreparedAction {
  tool: ActionName;
  /** Parámetros normalizados (nombres canónicos): es lo que se ejecuta y lo que la persona puede editar. */
  params: Record<string, unknown>;
  risk: Risk;
  summary: string;
}
