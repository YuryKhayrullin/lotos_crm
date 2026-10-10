#!/bin/sh
set -eu
umask 077
# CALLER MUST QUIESCE ALL WRITERS. pg_dump + filesystem is not one transaction.
case "$APP_ENV:$PGDATABASE" in staging:lotos_crm_staging|production:lotos_crm_production) ;; *) exit 1 ;; esac
[ "$PGHOST" = db ] && [ "$PGUSER" = lotos_backup ] || exit 1
[ -d /documents ] && [ -d /backups ] || exit 1
[ -z "$(find /documents -type l -print -quit)" ] || exit 1
bundle="/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -m 700 "$bundle"
pg_dump --format=custom --no-owner --no-acl --file="$bundle/database.dump"
tar -cpf "$bundle/documents.tar" -C /documents .
(cd "$bundle" && sha256sum database.dump documents.tar > SHA256SUMS)
pg_restore --list "$bundle/database.dump" >/dev/null
printf '%s\n' "$APP_ENV" > "$bundle/ENVIRONMENT"
# A marker exists ONLY after both snapshots/checksums finish successfully.
printf '%s\n' 'quiesced-bundle-v1' > "$bundle/COMPLETE"
printf '%s\n' 'Local backup bundle complete; offsite upload and restore verification still required.'
