-- Operator-only psql script for a NEW, dedicated Supabase staging project.
-- No passwords in this file or CLI arguments. Set them with psql \password
-- after this script, using three distinct generated 64-character hex values.
-- First verify the exact project ref/host and disable the project's Data API.
\set ON_ERROR_STOP on
BEGIN;
DO $$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Dedicated Supabase operator connection required';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public') THEN
    RAISE EXCEPTION 'Public schema is not empty; do not apply setup to an existing project';
  END IF;
END $$;
CREATE ROLE lotos_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE lotos_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE lotos_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT lotos_migrator TO postgres;
ALTER SCHEMA public OWNER TO lotos_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM anon, authenticated;
GRANT CONNECT ON DATABASE postgres TO lotos_migrator, lotos_runtime, lotos_backup;
GRANT USAGE ON SCHEMA public TO lotos_runtime, lotos_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE lotos_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lotos_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE lotos_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lotos_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE lotos_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO lotos_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE lotos_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE lotos_migrator IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER ROLE lotos_runtime SET statement_timeout = '10s';
ALTER ROLE lotos_runtime SET search_path = public;
ALTER ROLE lotos_migrator SET search_path = public;
ALTER ROLE lotos_backup SET search_path = public;
COMMIT;
-- In the same interactive psql session, use:
-- \password lotos_migrator
-- \password lotos_runtime
-- \password lotos_backup
-- Owner sets passwords; this script cannot create a CRM administrator.
