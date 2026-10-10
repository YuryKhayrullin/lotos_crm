const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('database readiness requires a real query against the target database over TCP', () => {
  for (const environment of ['local', 'test']) {
    const source = fs.readFileSync(path.join(__dirname, '../infra/compose.' + environment + '.yaml'), 'utf8')
    assert.match(source, /psql -h 127\.0\.0\.1/, 'initdb temporary socket server is not readiness')
    assert.match(source, /ON_ERROR_STOP=1/)
    assert.match(source, /-d "\$\$POSTGRES_DB"/)
    assert.match(source, /SELECT 1/)
    assert.doesNotMatch(source, /pg_isready/)
  }
})

const modulePromise = import('../scripts/lib/environment.mjs')
const local = () => ({
  APP_ENV: 'local',
  CRM_BACKEND: 'postgres',
  APP_URL: 'http://localhost:3001',
  DATABASE_URL: 'postgresql://lotos_local:' + '1'.repeat(64) + '@127.0.0.1:55432/lotos_crm_local',
  POSTGRES_USER: 'lotos_local',
  POSTGRES_DB: 'lotos_crm_local',
  POSTGRES_PASSWORD: '1'.repeat(64),
  BETTER_AUTH_SECRET: '2'.repeat(64),
})

test('local database settings accept only the dedicated loopback database', async () => {
  const { validateEnvironment } = await modulePromise
  assert.equal(validateEnvironment(local(), 'local').database, 'lotos_crm_local')
})

for (const [name, change] of [
  ['remote host', { DATABASE_URL: 'postgresql://lotos_local:password@club.example:55432/lotos_crm_local' }],
  ['Supabase host', { DATABASE_URL: 'postgresql://postgres:password@db.project.supabase.co:5432/postgres' }],
  ['production identity', { APP_ENV: 'production' }],
  ['production database', { DATABASE_URL: 'postgresql://lotos_local:password@127.0.0.1:55432/lotos_crm_production' }],
  ['wrong role', { POSTGRES_USER: 'postgres' }],
  ['default server port', { DATABASE_URL: 'postgresql://lotos_local:password@127.0.0.1:5432/lotos_crm_local' }],
  ['alternate protocol', { DATABASE_URL: 'https://db.example/lotos_crm_local' }],
  ['connection options', { DATABASE_URL: local().DATABASE_URL + '?options=unsafe' }],
  ['GAS backend', { CRM_BACKEND: 'gas' }],
  ['placeholder secret', { BETTER_AUTH_SECRET: 'replace-with-a-server-only-secret' }],
  ['mismatching credential', { POSTGRES_PASSWORD: '3'.repeat(64) }],
]) {
  test('environment guard rejects ' + name + ' without disclosing values', async () => {
    const { validateEnvironment } = await modulePromise
    assert.throws(
      () => validateEnvironment({ ...local(), ...change }, 'local'),
      (error) => {
        assert.doesNotMatch(error.message, /postgresql:|password@|supabase\.co|1{64}|2{64}/)
        return true
      },
    )
  })
}

test('test database is separate from the persistent local database', async () => {
  const { validateEnvironment } = await modulePromise
  assert.throws(() => validateEnvironment(local(), 'test'))
  const values = {
    ...local(),
    APP_ENV: 'test',
    POSTGRES_USER: 'lotos_test',
    POSTGRES_DB: 'lotos_crm_test',
    DATABASE_URL: 'postgresql://lotos_test:' + '1'.repeat(64) + '@127.0.0.1:55433/lotos_crm_test',
  }
  assert.equal(validateEnvironment(values, 'test').database, 'lotos_crm_test')
})

test('env parser rejects duplicate keys, shell substitution and malformed lines', async () => {
  const { parseEnv } = await modulePromise
  assert.deepEqual(parseEnv('# comment\nAPP_ENV=local\nAPP_URL="http://localhost:3001"\n'), {
    APP_ENV: 'local',
    APP_URL: 'http://localhost:3001',
  })
  for (const source of [
    'APP_ENV=local\nAPP_ENV=test',
    'APP_ENV=$(command)',
    'APP_ENV=${REMOTE_ENV}',
    'not an assignment',
  ]) {
    assert.throws(() => parseEnv(source))
  }
})

test('environment files have explicit paths; no default falls back to legacy .env.local', async () => {
  const { environmentFile } = await modulePromise
  assert.equal(environmentFile('local'), '.env.db.local')
  assert.equal(environmentFile('test'), '.env.db.test.local')
  assert.throws(() => environmentFile('../production'))
  assert.throws(() => environmentFile(undefined))
})
