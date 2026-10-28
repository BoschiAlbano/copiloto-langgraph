import { pathToFileURL } from "node:url";
import { loadEnvFile } from "../config/env.js";
import { createPrisma, type Db } from "./client.js";
import { generateSeed, type SeedData } from "./seed-generator.js";

const TABLES = ["clients", "staff", "services", "appointments", "products", "sales", "sale_items", "action_log"];

async function insertInChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>, size = 1000) {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

/** Vacía las tablas del negocio y las vuelve a llenar. Es idempotente. */
export async function seedDatabase(prisma: Db, data: SeedData = generateSeed(new Date())) {
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );

  // Los ids se asignan en el generador (para relacionar filas entre sí), así que
  // después hay que adelantar las secuencias para que los próximos INSERT no choquen.
  await prisma.client.createMany({ data: data.clients });
  await prisma.staff.createMany({ data: data.staff });
  await prisma.service.createMany({ data: data.services });
  await prisma.product.createMany({ data: data.products });
  await insertInChunks(data.appointments, (data) => prisma.appointment.createMany({ data }));
  await insertInChunks(data.sales, (data) => prisma.sale.createMany({ data }));
  await insertInChunks(data.saleItems, (data) => prisma.saleItem.createMany({ data }));

  for (const table of TABLES.filter((t) => t !== "action_log")) {
    await prisma.$queryRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), (SELECT MAX(id) FROM "${table}"))`,
    );
  }
}

// Se ejecuta solo cuando se lanza directamente (npm run db:seed), no al importarlo desde un test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile();
  const url = process.env.DATABASE_URL_WRITE;
  if (!url) {
    console.error("Falta la variable de entorno DATABASE_URL_WRITE. Revisá tu archivo .env (ver .env.example).");
    process.exit(1);
  }
  const prisma = createPrisma(url);
  try {
    await seedDatabase(prisma);
    const counts = {
      clients: await prisma.client.count(),
      staff: await prisma.staff.count(),
      services: await prisma.service.count(),
      products: await prisma.product.count(),
      appointments: await prisma.appointment.count(),
      sales: await prisma.sale.count(),
      sale_items: await prisma.saleItem.count(),
    };
    console.log("Seed cargado:", counts);
  } finally {
    await prisma.$disconnect();
  }
}
