#!/bin/sh
set -eu
# Read-only operator probe. Route details, paths and credentials are not logged.
[ "$#" -eq 2 ] || exit 1
case "$1" in staging|production) ;; *) exit 1 ;; esac
case "$2" in /srv/lotos-crm|/opt/lotos-crm) ;; *) exit 1 ;; esac
environment="$1"
cd "$2"
node scripts/deployment-check.mjs "$environment" >/dev/null
compose() {
  docker compose --project-name "lotos-crm-$environment" --env-file ".env.$environment.local" --file infra/compose.self-hosted.yaml "$@"
}
compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/health/ready',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Alert, don't erase files, when the backup disk has less than 1 GiB free.
free_kb="$(df -Pk "/var/lib/lotos-crm/backups/$environment" | awk 'NR==2 {print $4}')"
[ "$free_kb" -gt 1048576 ] || exit 1
# A stale/missing COMPLETE marker is failure, not a fabricated healthy backup.
[ -n "$(find "/var/lib/lotos-crm/backups/$environment" -name COMPLETE -type f -mmin -1500 -print -quit)" ] || exit 1
printf '%s\n' 'App, backup disk and recent LOCAL bundle probe passed; also verify external HTTPS and offsite snapshot age.'
