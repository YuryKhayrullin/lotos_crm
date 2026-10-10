#!/bin/sh
set -eu
# Operator/systemd entrypoint on the chosen VPS, never invoked by CI/agent.
# RESTIC_REPOSITORY and RESTIC_PASSWORD_FILE come from a PRIVATE systemd env.
[ "$#" -eq 2 ] || exit 1
environment="$1"
case "$environment" in staging|production) ;; *) exit 1 ;; esac
case "$2" in /srv/lotos-crm|/opt/lotos-crm) ;; *) exit 1 ;; esac
cd "$2"
node scripts/deployment-check.mjs "$environment" >/dev/null
[ -n "${RESTIC_REPOSITORY:-}" ] && [ -r "${RESTIC_PASSWORD_FILE:-}" ] || exit 1
case "$RESTIC_REPOSITORY" in sftp:*|s3:*|rest:https:*) ;; *) exit 1 ;; esac
[ ! -L "$RESTIC_PASSWORD_FILE" ] || exit 1
[ "$(stat -c %u "$RESTIC_PASSWORD_FILE")" = "$(id -u)" ] || exit 1
case "$(stat -c %a "$RESTIC_PASSWORD_FILE")" in 400|600) ;; *) exit 1 ;; esac
compose() {
  docker compose --project-name "lotos-crm-$environment" --env-file ".env.$environment.local" --file infra/compose.self-hosted.yaml "$@"
}
container_id="$(compose ps -q app)"
[ -n "$container_id" ] || exit 1
[ "$(docker inspect --format '{{.State.Running}}' "$container_id")" = true ] || exit 1
# Gracefully freeze writers. Even a failed dump/upload must restart the app.
restart_app() {
  result="$?"
  trap - EXIT
  compose start app >/dev/null 2>&1 || result=1
  exit "$result"
}
trap restart_app EXIT
trap 'exit 1' HUP INT TERM
compose stop --timeout 30 app
compose --profile ops run --rm backup
compose start app
# Release downtime before slow offsite upload; SQL and files are already frozen.
trap - EXIT HUP INT TERM
restic backup "/var/lib/lotos-crm/backups/$environment" --tag "lotos-$environment"
restic check --read-data-subset=5%
# No automatic prune/deletion. Retention becomes active after verified restores.
printf '%s\n' 'Offsite snapshot completed; monitor job exit status and perform regular clean-room restores.'
