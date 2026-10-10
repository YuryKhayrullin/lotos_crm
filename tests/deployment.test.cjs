const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const validator = import('../scripts/lib/deployment.mjs')
function fixture(environment = 'staging') {
  return {
    APP_ENV: environment,
    CRM_BACKEND: 'postgres',
    APP_URL: `https://${environment}.fictional.test`,
    CRM_DOMAIN: `${environment}.fictional.test`,
    POSTGRES_DB: 'lotos_crm_' + environment,
    POSTGRES_PASSWORD: '1'.repeat(64),
    RUNTIME_PASSWORD: '2'.repeat(64),
    MIGRATOR_PASSWORD: '3'.repeat(64),
    BACKUP_PASSWORD: '4'.repeat(64),
    BETTER_AUTH_SECRET: '5'.repeat(64),
    DATABASE_URL: `postgresql://lotos_runtime:${'2'.repeat(64)}@db:5432/lotos_crm_${environment}`,
    DIRECT_URL: `postgresql://lotos_migrator:${'3'.repeat(64)}@db:5432/lotos_crm_${environment}`,
    APP_IMAGE: 'sha256:' + '6'.repeat(64),
    MIGRATOR_IMAGE: 'sha256:' + '7'.repeat(64),
    ACME_EMAIL: 'fictional@example.invalid',
    TRUSTED_PROXY: 'caddy',
    COACH_REGISTRATION_ENABLED: 'false',
    DOCUMENTS_DIR: '/var/lib/lotos-crm/documents/' + environment,
    BACKUPS_DIR: '/var/lib/lotos-crm/backups/' + environment,
  }
}
test('deployment preflight requires isolated roles, pinned images and exact environment mounts', async () => {
  const { validateDeployment } = await validator
  for (const environment of ['staging', 'production'])
    assert.equal(validateDeployment(fixture(environment), environment).isolatedRoles, true)
  for (const change of [
    { APP_ENV: 'local' },
    { BACKUP_PASSWORD: '2'.repeat(64) },
    { APP_IMAGE: 'lotos:latest' },
    { BACKUPS_DIR: '/' },
    { CRM_DOMAIN: 'other.fictional.test' },
    { TRUSTED_PROXY: 'none' },
    { COACH_REGISTRATION_ENABLED: 'true' },
    { DOCUMENTS_DIR: '/var/lib/lotos-crm/documents/production' },
    { DIRECT_URL: fixture().DATABASE_URL },
  ])
    assert.throws(() => validateDeployment({ ...fixture(), ...change }, 'staging'))
})
test('container build cannot include credentials, old workbook or private volumes', () => {
  const ignore = fs.readFileSync(path.join(__dirname, '../.dockerignore'), 'utf8')
  for (const entry of ['**/.env*', '.private', '.artifacts', '.migration-baseline', '**/*.xlsx', '.git'])
    assert.ok(ignore.split('\n').includes(entry))
  const docker = fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8')
  assert.match(docker, /USER lotos/)
  assert.doesNotMatch(docker, /COPY.*\.env|ARG.*PASSWORD|ARG.*SECRET/)
})
test('private Caddy upstream overwrites client IP and serves no document volume', () => {
  const source = fs.readFileSync(path.join(__dirname, '../infra/Caddyfile'), 'utf8')
  assert.match(source, /header_up X-Lotos-Client-IP \{http\.request\.remote\.host\}/)
  assert.match(source, /max_size 8MB/)
  assert.doesNotMatch(source, /file_server|\/documents|trusted_proxies/)
})
test('backup freezes writers with an early recovery trap, and preserves private tar permissions', () => {
  const host = fs.readFileSync(path.join(__dirname, '../infra/ops/backup-host.sh'), 'utf8')
  assert.ok(host.indexOf('trap restart_app EXIT') < host.indexOf('compose stop --timeout 30 app'))
  assert.match(host, /RESTIC_PASSWORD_FILE/)
  assert.match(host, /restic check/)
  const bundle = fs.readFileSync(path.join(__dirname, '../infra/ops/backup-bundle.sh'), 'utf8')
  assert.match(bundle, /umask 077/)
  assert.match(bundle, /tar -cpf/)
  assert.ok(bundle.indexOf('pg_dump') < bundle.indexOf('> "$bundle/COMPLETE"'))
})
