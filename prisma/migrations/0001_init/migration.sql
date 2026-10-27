-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('scheduled', 'done', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'card', 'transfer');

-- CreateTable
CREATE TABLE "clients" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" SERIAL NOT NULL,
    "client_id" INTEGER NOT NULL,
    "staff_id" INTEGER NOT NULL,
    "service_id" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'scheduled',

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "stock" INTEGER NOT NULL,
    "min_stock" INTEGER NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" SERIAL NOT NULL,
    "client_id" INTEGER,
    "total" INTEGER NOT NULL,
    "payment_method" "PaymentMethod" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" SERIAL NOT NULL,
    "sale_id" INTEGER NOT NULL,
    "product_id" INTEGER,
    "service_id" INTEGER,
    "qty" INTEGER NOT NULL,
    "unit_price" INTEGER NOT NULL,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_log" (
    "id" SERIAL NOT NULL,
    "thread_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "decision" TEXT,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "action_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appointments_starts_at_idx" ON "appointments"("starts_at");

-- CreateIndex
CREATE INDEX "appointments_client_id_idx" ON "appointments"("client_id");

-- CreateIndex
CREATE INDEX "appointments_staff_id_starts_at_idx" ON "appointments"("staff_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_service_id_idx" ON "appointments"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE INDEX "sales_created_at_idx" ON "sales"("created_at");

-- CreateIndex
CREATE INDEX "sales_client_id_idx" ON "sales"("client_id");

-- CreateIndex
CREATE INDEX "sale_items_sale_id_idx" ON "sale_items"("sale_id");

-- CreateIndex
CREATE INDEX "sale_items_product_id_idx" ON "sale_items"("product_id");

-- CreateIndex
CREATE INDEX "sale_items_service_id_idx" ON "sale_items"("service_id");

-- CreateIndex
CREATE INDEX "action_log_thread_id_idx" ON "action_log"("thread_id");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================
-- Reglas que Prisma no expresa en su esquema (se agregan a mano)
-- ============================================================

-- Un barbero no puede tener dos turnos superpuestos (los cancelados no ocupan el horario).
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_valid_range" CHECK ("ends_at" > "starts_at"),
  ADD CONSTRAINT "appointments_no_overlap"
    EXCLUDE USING gist (
      "staff_id" WITH =,
      tstzrange("starts_at", "ends_at") WITH &&
    ) WHERE ("status" <> 'cancelled');

-- Cada renglón de venta es de un producto o de un servicio, nunca de ambos ni de ninguno.
ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_one_target"
    CHECK (("product_id" IS NOT NULL) <> ("service_id" IS NOT NULL)),
  ADD CONSTRAINT "sale_items_qty_positive" CHECK ("qty" > 0),
  ADD CONSTRAINT "sale_items_price_nonneg" CHECK ("unit_price" >= 0);

ALTER TABLE "products"
  ADD CONSTRAINT "products_stock_nonneg" CHECK ("stock" >= 0),
  ADD CONSTRAINT "products_min_stock_nonneg" CHECK ("min_stock" >= 0),
  ADD CONSTRAINT "products_price_nonneg" CHECK ("price" >= 0);

ALTER TABLE "services"
  ADD CONSTRAINT "services_duration_positive" CHECK ("duration_min" > 0),
  ADD CONSTRAINT "services_price_nonneg" CHECK ("price" >= 0);

ALTER TABLE "sales" ADD CONSTRAINT "sales_total_nonneg" CHECK ("total" >= 0);

-- Supabase expone `public` por su API REST: con RLS activado y sin políticas,
-- las claves anon/authenticated no ven nada. El rol postgres (BYPASSRLS) sigue funcionando.
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "action_log" ENABLE ROW LEVEL SECURITY;