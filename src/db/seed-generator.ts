import { CLIENTS, PAYMENT_METHODS, PRODUCTS, SERVICES, STAFF } from "./seed-data.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ART_OFFSET = 3 * HOUR; // Argentina = UTC-3

const HISTORY_DAYS = 90;
const FUTURE_DAYS = 14;
const OPEN_MIN = 10 * 60; // 10:00 hora local
const CLOSE_MIN = 20 * 60; // 20:00 hora local

type Status = "scheduled" | "done" | "cancelled" | "no_show";
type Payment = (typeof PAYMENT_METHODS)[number];

export interface SeedData {
  clients: { id: number; name: string; phone: string; email: string; notes: string | null; createdAt: Date }[];
  staff: { id: number; name: string; active: boolean }[];
  services: { id: number; name: string; durationMin: number; price: number }[];
  products: { id: number; name: string; sku: string; price: number; stock: number; minStock: number }[];
  appointments: {
    id: number;
    clientId: number;
    staffId: number;
    serviceId: number;
    startsAt: Date;
    endsAt: Date;
    status: Status;
  }[];
  sales: { id: number; clientId: number | null; total: number; paymentMethod: Payment; createdAt: Date }[];
  saleItems: {
    id: number;
    saleId: number;
    productId: number | null;
    serviceId: number | null;
    qty: number;
    unitPrice: number;
  }[];
}

/** Generador pseudoaleatorio con semilla: misma semilla, misma secuencia. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Genera ~90 días de historial y 14 de agenda futura, coherentes entre sí.
 * Es una función pura: no toca la base. `now` ancla las fechas para que
 * "ayer", "esta semana" y "mañana" tengan datos siempre.
 */
export function generateSeed(now: Date, seed = 42): SeedData {
  const rng = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
  const pick = <T>(items: readonly T[]) => items[int(0, items.length - 1)]!;

  // Medianoche local de hoy, como instante UTC.
  const localDayStart = Math.floor((now.getTime() - ART_OFFSET) / DAY) * DAY;
  const dayStartUtc = (offset: number) => localDayStart + offset * DAY + ART_OFFSET;
  const weekday = (offset: number) => new Date(localDayStart + offset * DAY).getUTCDay();

  const clients = CLIENTS.map(([name, notes], i) => ({
    id: i + 1,
    name,
    phone: `+54 9 11 ${String(5000 + i * 37).padStart(4, "0")}-${String(1000 + i * 91).slice(-4)}`,
    email: `${name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, ".")}@example.com`,
    notes,
    createdAt: new Date(dayStartUtc(-HISTORY_DAYS - int(0, 200))),
  }));
  const staff = STAFF.map((name, i) => ({ id: i + 1, name, active: true }));
  const services = SERVICES.map((s, i) => ({ id: i + 1, ...s }));

  // Turnos: por día hábil (lunes a sábado) y por barbero, uno detrás de otro sin superponerse.
  const serviceWeights = [0.45, 0.15, 0.3, 0.1];
  const pickService = () => {
    let r = rng();
    for (let i = 0; i < services.length; i++) {
      r -= serviceWeights[i]!;
      if (r < 0) return services[i]!;
    }
    return services[0]!;
  };

  const rawAppointments: Omit<SeedData["appointments"][number], "id">[] = [];
  for (let d = -HISTORY_DAYS; d <= FUTURE_DAYS; d++) {
    if (weekday(d) === 0) continue; // domingo cerrado
    for (const barber of staff) {
      let cursor = OPEN_MIN + int(0, 3) * 15;
      while (true) {
        const service = pickService();
        if (cursor + service.durationMin > CLOSE_MIN) break;
        if (rng() < 0.4) {
          cursor += int(1, 3) * 15; // hueco libre
          continue;
        }
        const startsAt = new Date(dayStartUtc(d) + cursor * MIN);
        const endsAt = new Date(startsAt.getTime() + service.durationMin * MIN);
        const r = rng();
        let status: Status;
        if (endsAt <= now) status = r < 0.82 ? "done" : r < 0.92 ? "cancelled" : "no_show";
        else status = r < 0.95 ? "scheduled" : "cancelled";
        rawAppointments.push({
          clientId: int(1, clients.length),
          staffId: barber.id,
          serviceId: service.id,
          startsAt,
          endsAt,
          status,
        });
        cursor += service.durationMin + int(0, 2) * 15;
      }
    }
  }
  rawAppointments.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const appointments = rawAppointments.map((a, i) => ({ id: i + 1, ...a }));

  // Ventas: una por turno realizado (a veces con un producto) más ventas de mostrador.
  type RawItem = { productId: number | null; serviceId: number | null; qty: number; unitPrice: number };
  const rawSales: { clientId: number | null; paymentMethod: Payment; createdAt: Date; items: RawItem[] }[] = [];

  for (const appt of appointments) {
    if (appt.status !== "done") continue;
    const service = services[appt.serviceId - 1]!;
    const items: RawItem[] = [{ productId: null, serviceId: service.id, qty: 1, unitPrice: service.price }];
    if (rng() < 0.3) {
      const productIdx = int(0, PRODUCTS.length - 1);
      items.push({ productId: productIdx + 1, serviceId: null, qty: rng() < 0.1 ? 2 : 1, unitPrice: PRODUCTS[productIdx]!.price });
    }
    rawSales.push({ clientId: appt.clientId, paymentMethod: pick(PAYMENT_METHODS), createdAt: appt.endsAt, items });
  }

  for (let d = -HISTORY_DAYS; d <= -1; d++) {
    if (weekday(d) === 0) continue;
    for (let n = int(1, 3); n > 0; n--) {
      const productCount = int(1, 2);
      const chosen = new Set<number>();
      while (chosen.size < productCount) chosen.add(int(0, PRODUCTS.length - 1));
      const items = [...chosen].map((idx) => ({
        productId: idx + 1,
        serviceId: null,
        qty: int(1, 2),
        unitPrice: PRODUCTS[idx]!.price,
      }));
      rawSales.push({
        clientId: rng() < 0.5 ? int(1, clients.length) : null,
        paymentMethod: pick(PAYMENT_METHODS),
        createdAt: new Date(dayStartUtc(d) + int(OPEN_MIN, CLOSE_MIN - 1) * MIN),
        items,
      });
    }
  }
  rawSales.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Stock: se simula en orden cronológico; si no alcanza, "llega reposición" antes de vender.
  const stock = PRODUCTS.map(() => int(15, 40));
  const sales: SeedData["sales"] = [];
  const saleItems: SeedData["saleItems"] = [];
  rawSales.forEach((sale, i) => {
    const saleId = i + 1;
    let total = 0;
    for (const item of sale.items) {
      if (item.productId !== null) {
        const idx = item.productId - 1;
        if (stock[idx]! < item.qty) stock[idx]! += int(25, 40);
        stock[idx]! -= item.qty;
      }
      total += item.qty * item.unitPrice;
      saleItems.push({ id: saleItems.length + 1, saleId, ...item });
    }
    sales.push({ id: saleId, clientId: sale.clientId, total, paymentMethod: sale.paymentMethod, createdAt: sale.createdAt });
  });

  const products = PRODUCTS.map((p, i) => ({ id: i + 1, ...p, stock: stock[i]! }));

  return { clients, staff, services, products, appointments, sales, saleItems };
}
