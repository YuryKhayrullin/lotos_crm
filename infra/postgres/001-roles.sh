#!/bin/sh
set -eu
# Entrypoint-only on a NEW dedicated volume. Never reset an existing database.
case "$POSTGRES_DB" in lotos_crm_staging|lotos_crm_production) ;; *) exit 1 ;; esac
for password in "$RUNTIME_PASSWORD" "$MIGRATOR_PASSWORD" "$BACKUP_PASSWORD"; do
  [ "${#password}" -eq 64 ] || exit 1
  case "$password" in *[!a-f0-9]*) exit 1 ;; esac
  [ "$password" != "$POSTGRES_PASSWORD" ] || exit 1
done
[ "$RUNTIME_PASSWORD" != "$MIGRATOR_PASSWORD" ] || exit 1
[ "$RUNTIME_PASSWORD" != "$BACKUP_PASSWORD" ] || exit 1
[ "$BACKUP_PASSWORD" != "$MIGRATOR_PASSWORD" ] || exit 1
# Validated hex values go over stdin, not psql -v arguments/process listings.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
BEGIN;
CREATE ROLE lotos_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$MIGRATOR_PASSWORD';
CREATE ROLE lotos_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$RUNTIME_PASSWORD';
CREATE ROLE lotos_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$BACKUP_PASSWORD';
ALTER DATABASE $POSTGRES_DB OWNER TO lotos_migrator;
ALTER SCHEMA public OWNER TO lotos_migrator;
REVOKE ALL ON DATABASE $POSTGRES_DB FROM PUBLIC;
GRANT CONNECT ON DATABASE $POSTGRES_DB TO lotos_runtime, lotos_backup;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO lotos_runtime, lotos_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE lotos_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lotos_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE lotos_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO lotos_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE lotos_migrator IN SCHEMA public GRANT SELECT ON TABLES TO lotos_backup;
COMMIT;
SQL
