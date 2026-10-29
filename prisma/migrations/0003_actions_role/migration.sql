-- Rol que ejecuta las acciones aprobadas por la persona (fase 5): el ÚNICO que escribe datos del negocio.
-- Nace sin login ni contraseña; `npm run db:roles` le asigna la de DATABASE_URL_ACTIONS.
-- Permisos mínimos y por columna: no puede borrar nada, no puede cambiar otras columnas ni la estructura.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'copilot_actions') THEN
    CREATE ROLE copilot_actions NOLOGIN;
  END IF;
END
$$;

-- Una acción es una transacción corta: si algo se cuelga, se corta.
ALTER ROLE copilot_actions SET statement_timeout = '5s';

GRANT USAGE ON SCHEMA public TO copilot_actions;

-- Leer lo necesario para comprobar reglas y devolver el resultado (RETURNING también lo necesita).
GRANT SELECT ON "clients", "staff", "services", "appointments", "products", "sales", "sale_items"
  TO copilot_actions;

-- Escribir, y solo esto:
GRANT INSERT ON "appointments", "sales", "sale_items" TO copilot_actions;   -- agendar y vender
GRANT UPDATE ("status") ON "appointments" TO copilot_actions;               -- cancelar
GRANT UPDATE ("stock") ON "products" TO copilot_actions;                    -- vender y ajustar stock
GRANT USAGE ON SEQUENCE "appointments_id_seq", "sales_id_seq", "sale_items_id_seq", "action_log_id_seq"
  TO copilot_actions;

-- Auditoría de solo agregado: se puede escribir y leer, nunca modificar ni borrar.
GRANT SELECT, INSERT ON "action_log" TO copilot_actions;

-- Las tablas tienen RLS activo: sin política, el rol vería cero filas y no podría escribir.
CREATE POLICY "actions_select" ON "clients" FOR SELECT TO copilot_actions USING (true);
CREATE POLICY "actions_select" ON "staff" FOR SELECT TO copilot_actions USING (true);
CREATE POLICY "actions_select" ON "services" FOR SELECT TO copilot_actions USING (true);
CREATE POLICY "actions_select" ON "appointments" FOR SELECT TO copilot_actions USING (true);
CREATE POLICY "actions_insert" ON "appointments" FOR INSERT TO copilot_actions WITH CHECK (true);
CREATE POLICY "actions_update" ON "appointments" FOR UPDATE TO copilot_actions USING (true) WITH CHECK (true);
CREATE POLICY "actions_select" ON "products" FOR SELECT TO copilot_actions USING (true);
CREATE POLICY "actions_update" ON "products" FOR UPDATE TO copilot_actions USING (true) WITH CHECK (true);
CREATE POLICY "actions_select" ON "sales" FOR SELECT TO copilot_actions USING (true);
CREATE POLICY "actions_insert" ON "sales" FOR INSERT TO copilot_actions WITH CHECK (true);
CREATE POLICY "actions_select" ON "sale_items" FOR SELECT TO copilot_actions USING (true);
CREATE POLICY "actions_insert" ON "sale_items" FOR INSERT TO copilot_actions WITH CHECK (true);
CREATE POLICY "actions_select" ON "action_log" FOR SELECT TO copilot_actions USING (true);
CREATE POLICY "actions_insert" ON "action_log" FOR INSERT TO copilot_actions WITH CHECK (true);

-- Una acción se ejecuta una sola vez: el id de la acción (hilo + llamada a herramienta) es único en la auditoría.
CREATE UNIQUE INDEX "action_log_action_id_key" ON "action_log" ((payload->>'actionId'));
