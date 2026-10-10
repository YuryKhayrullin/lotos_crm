import { validateEnvironment } from './environment.mjs'

function requireSafe(value, field) {
  if (!value) throw Error('Unsafe deployment setting: ' + field)
}
export function validateDeployment(values, expected) {
  requireSafe(['staging', 'production'].includes(expected), 'APP_ENV')
  validateEnvironment(values, expected)
  requireSafe(!values.DEPLOY_TARGET || values.DEPLOY_TARGET === 'self-hosted', 'self-hosted target')
  const runtime = new URL(values.DATABASE_URL),
    direct = new URL(values.DIRECT_URL || '')
  requireSafe(values.POSTGRES_DB === 'lotos_crm_' + expected, 'POSTGRES_DB')
  const passwords = [
    values.POSTGRES_PASSWORD,
    values.RUNTIME_PASSWORD,
    values.MIGRATOR_PASSWORD,
    values.BACKUP_PASSWORD,
    values.BETTER_AUTH_SECRET,
  ]
  requireSafe(
    passwords.every((value) => /^[a-f0-9]{64}$/.test(value || '')) && new Set(passwords).size === 5,
    'separate secrets',
  )
  requireSafe(runtime.password === values.RUNTIME_PASSWORD, 'runtime identity')
  requireSafe(
    direct.protocol === 'postgresql:' &&
      direct.hostname === 'db' &&
      direct.port === '5432' &&
      direct.pathname === runtime.pathname &&
      direct.username === 'lotos_migrator' &&
      direct.password === values.MIGRATOR_PASSWORD &&
      !direct.search &&
      !direct.hash,
    'migration identity',
  )
  const app = new URL(values.APP_URL)
  requireSafe(
    values.CRM_DOMAIN === app.hostname && /^[a-z0-9][a-z0-9.-]+[a-z0-9]$/.test(values.CRM_DOMAIN) && !app.port,
    'CRM_DOMAIN',
  )
  requireSafe(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.ACME_EMAIL || ''), 'ACME_EMAIL')
  for (const field of ['APP_IMAGE', 'MIGRATOR_IMAGE'])
    requireSafe(/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64})$/.test(values[field] || ''), field)
  requireSafe(
    values.TRUSTED_PROXY === 'caddy' && values.COACH_REGISTRATION_ENABLED === 'false',
    'private Caddy/registration',
  )
  requireSafe(values.DOCUMENTS_DIR === '/var/lib/lotos-crm/documents/' + expected, 'DOCUMENTS_DIR')
  requireSafe(values.BACKUPS_DIR === '/var/lib/lotos-crm/backups/' + expected, 'BACKUPS_DIR')
  return {
    environment: expected,
    hostname: values.CRM_DOMAIN,
    database: values.POSTGRES_DB,
    pinnedImages: true,
    isolatedRoles: true,
  }
}
