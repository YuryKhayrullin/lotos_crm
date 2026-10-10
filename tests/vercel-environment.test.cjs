const test = require('node:test')
const assert = require('node:assert/strict')
const modulePromise = import('../scripts/lib/environment.mjs')
function fixture() {
  return {
    APP_ENV: 'staging',
    DEPLOY_TARGET: 'vercel',
    CRM_BACKEND: 'postgres',
    APP_URL: 'https://lotos-fictional-staging.vercel.app',
    CLOUD_DATABASE_HOST: 'ep-fictional-pooler.eu-central-1.aws.neon.tech',
    CLOUD_DATABASE_DIRECT_HOST: 'ep-fictional.eu-central-1.aws.neon.tech',
    DATABASE_URL: `postgresql://lotos_runtime:${'1'.repeat(64)}@ep-fictional-pooler.eu-central-1.aws.neon.tech:5432/lotos_crm_staging?sslmode=verify-full`,
    DIRECT_URL: `postgresql://lotos_migrator:${'2'.repeat(64)}@ep-fictional.eu-central-1.aws.neon.tech:5432/lotos_crm_staging?sslmode=verify-full`,
    BETTER_AUTH_SECRET: '3'.repeat(64),
    DOCUMENT_STORAGE: 'vercel-blob',
    BLOB_STORE_ID: 'store_fictional123',
    TRUSTED_PROXY: 'vercel',
    COACH_REGISTRATION_ENABLED: 'false',
  }
}
test('cloud profile is explicit, staging-only and bound to exact TLS pooler identity', async () => {
  const { validateEnvironment } = await modulePromise
  assert.equal(validateEnvironment(fixture(), 'staging').database, 'lotos_crm_staging')
  for (const patch of [
    { APP_ENV: 'production' },
    { APP_ENV: 'local' },
    { DEPLOY_TARGET: 'unknown' },
    { DATABASE_URL: fixture().DATABASE_URL.replace('verify-full', 'require') },
    { DATABASE_URL: fixture().DATABASE_URL.replace('ep-fictional-pooler', 'ep-other-pooler') },
    { DATABASE_URL: fixture().DATABASE_URL.replace('lotos_runtime', 'neondb_owner') },
    { DATABASE_URL: fixture().DATABASE_URL + '&sslmode=verify-full' },
    { DATABASE_URL: fixture().DATABASE_URL.replace('lotos_crm_staging', 'neondb') },
    { DOCUMENT_STORAGE: 'filesystem' },
    { DEBUG: 'blob' },
    { NEXT_PUBLIC_BETTER_AUTH_SECRET: '3'.repeat(64) },
    { DOCUMENTS_DIR: '/tmp' },
    { TRUSTED_PROXY: 'caddy' },
    { COACH_REGISTRATION_ENABLED: 'true' },
    { BLOB_STORE_ID: '' },
  ])
    assert.throws(() => validateEnvironment({ ...fixture(), ...patch }, 'staging'))
})
test('cloud migration uses a separate direct identity and cannot target an arbitrary endpoint', async () => {
  const { validateCloudMigration } = await modulePromise
  assert.equal(validateCloudMigration(fixture()).username, 'lotos_migrator')
  for (const direct of [
    fixture().DATABASE_URL,
    fixture().DIRECT_URL.replace('ep-fictional.', 'ep-other.'),
    fixture().DIRECT_URL.replace('verify-full', 'disable'),
    fixture().DIRECT_URL.replace('lotos_crm_staging', 'lotos_crm_production'),
    fixture().DIRECT_URL.replace('2'.repeat(64), '1'.repeat(64)),
  ])
    assert.throws(() => validateCloudMigration({ ...fixture(), DIRECT_URL: direct }))
})

test('Vercel without receipts explicitly disables storage without loosening environment isolation', async () => {
  const { validateEnvironment, validateCloudMigration } = await modulePromise
  const values = { ...fixture(), DOCUMENT_STORAGE: 'disabled' }
  delete values.BLOB_STORE_ID
  assert.equal(validateEnvironment(values, 'staging').database, 'lotos_crm_staging')
  assert.equal(validateCloudMigration(values).username, 'lotos_migrator')
  for (const patch of [
    { DOCUMENT_STORAGE: '' },
    { DOCUMENT_STORAGE: 'unknown' },
    { DOCUMENT_STORAGE: 'filesystem' },
    { BLOB_STORE_ID: 'store_fictional123' },
    { BLOB_READ_WRITE_TOKEN: 'never-a-real-token' },
    { DOCUMENTS_DIR: '/tmp' },
    { APP_ENV: 'production' },
    { APP_ENV: 'test' },
  ])
    assert.throws(() => validateEnvironment({ ...values, ...patch }, 'staging'))
})
