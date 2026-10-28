-- Rol de solo lectura para las herramientas de consulta del agente.
-- La migración no lleva secretos: el rol nace sin login y `npm run db:roles`
-- le asigna la contraseña que está en DATABASE_URL_READ.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'copilot_reader') THEN
    CREATE ROLE copilot_reader NOLOGIN;
  END IF;
END
$$;

-- Segunda barrera: las sesiones de este rol arrancan en modo solo lectura.
ALTER ROLE copilot_reader SET default_transaction_read_only = on;

-- Primera barrera: solo SELECT, y solo sobre las tablas del negocio.
-- action_log queda afuera a propósito.
GRANT USAGE ON SCHEMA public TO copilot_reader;
GRANT SELECT ON "clients", "staff", "services", "appointments", "products", "sales", "sale_items"
  TO copilot_reader;

-- Las tablas tienen RLS activo: sin política, el rol vería cero filas.
CREATE POLICY "reader_select" ON "clients" FOR SELECT TO copilot_reader USING (true);
CREATE POLICY "reader_select" ON "staff" FOR SELECT TO copilot_reader USING (true);
CREATE POLICY "reader_select" ON "services" FOR SELECT TO copilot_reader USING (true);
CREATE POLICY "reader_select" ON "appointments" FOR SELECT TO copilot_reader USING (true);
CREATE POLICY "reader_select" ON "products" FOR SELECT TO copilot_reader USING (true);
CREATE POLICY "reader_select" ON "sales" FOR SELECT TO copilot_reader USING (true);
CREATE POLICY "reader_select" ON "sale_items" FOR SELECT TO copilot_reader USING (true);
