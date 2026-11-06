-- Corre una sola vez, al crear la base (docker-entrypoint-initdb.d). La migración inicial instala btree_gist en el
-- esquema `extensions`, que en Supabase ya existe; en un Postgres solo hay que crearlo.
CREATE SCHEMA IF NOT EXISTS extensions;
