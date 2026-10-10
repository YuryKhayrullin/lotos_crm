const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const tls = require('node:tls')
const { spawnSync } = require('node:child_process')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lotos-test-ca-'))
const certificate = path.join(temporary, 'root.crt')
const key = path.join(temporary, 'root.key')
const generated = spawnSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    certificate,
    '-days',
    '2',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  ],
  { stdio: 'ignore' },
)
assert.equal(generated.status, 0, 'OpenSSL generates a disposable test certificate')
test.after(() => {
  fs.unlinkSync(certificate)
  fs.unlinkSync(key)
  fs.rmdirSync(temporary)
})
const certificatePem = fs.readFileSync(certificate, 'utf8')
const environment = import('../scripts/lib/environment.mjs')
const database = import('../scripts/lib/cloud-database.mjs')
const migration = import('../scripts/lib/cloud-migration-tls.mjs')
const bootstrapPsql = import('../scripts/lib/bootstrap-psql.mjs')
function fixture() {
  const ref = 'abcdefghijklmnopqrst'
  const host = 'aws-0-eu-central-1.pooler.supabase.com'
  return {
    APP_ENV: 'staging',
    DEPLOY_TARGET: 'vercel',
    CRM_BACKEND: 'postgres',
    APP_URL: 'https://lotos-fictional-staging.vercel.app',
    CLOUD_DATABASE_PROVIDER: 'supabase',
    CLOUD_DATABASE_ISOLATED: 'true',
    CLOUD_SUPABASE_PROJECT_REF: ref,
    CLOUD_DATABASE_HOST: host,
    CLOUD_DATABASE_DIRECT_HOST: host,
    CLOUD_DATABASE_CA_BASE64: Buffer.from(certificatePem).toString('base64'),
    DATABASE_URL: `postgresql://lotos_runtime.${ref}:${'1'.repeat(64)}@${host}:6543/postgres?sslmode=verify-full`,
    DIRECT_URL: `postgresql://lotos_migrator.${ref}:${'2'.repeat(64)}@${host}:5432/postgres?sslmode=verify-full`,
    BETTER_AUTH_SECRET: '3'.repeat(64),
    DOCUMENT_STORAGE: 'disabled',
    TRUSTED_PROXY: 'vercel',
    COACH_REGISTRATION_ENABLED: 'false',
  }
}
test('owner bootstrap uses runtime identity on Session IPv4 without password/hash in arguments', async () => {
  const { bootstrapPsqlPlan } = await bootstrapPsql
  const values = { ...fixture(), BOOTSTRAP_CLOUD_ADMIN: 'explicit-operator' }
  const plan = bootstrapPsqlPlan(values, '/tmp/fictional-ca/root.crt')
  const args = plan.args.join(' ')
  assert.match(args, /user=lotos_runtime\.abcdefghijklmnopqrst/)
  assert.match(args, /port=5432/)
  assert.match(args, /sslmode=verify-full/)
  assert.ok(plan.args.includes('unix:///var/run/docker.sock'))
  assert.ok(plan.args.includes('--pull=never'))
  assert.ok(plan.args.includes('--file=-'))
  assert.ok(!args.includes('1'.repeat(64)))
  assert.ok(!args.includes('2'.repeat(64)))
  assert.equal(plan.password, '1'.repeat(64))
  assert.ok(values.DATABASE_URL.includes(':6543/'))
  for (const patch of [
    { APP_ENV: 'production' },
    { BOOTSTRAP_CLOUD_ADMIN: undefined },
    { DATABASE_URL: values.DATABASE_URL.replace('lotos_runtime.', 'postgres.') },
  ])
    assert.throws(() => bootstrapPsqlPlan({ ...values, ...patch }, '/tmp/fictional-ca/root.crt'))
})

test('native bootstrap child results never expose private SQL or stderr', async () => {
  const { bootstrapPsqlResult } = await bootstrapPsql
  const secret = 'fictional-credential-never-print'
  assert.throws(
    () => bootstrapPsqlResult({ status: 3, stderr: secret }),
    (error) => error.code === 'PSQL_FAILED' && !error.message.includes(secret),
  )
  assert.throws(
    () => bootstrapPsqlResult({ status: 3, stderr: 'psql:<stdin>:29: ERROR:  BOOTSTRAP_ALREADY_EXISTS\n' }),
    { code: 'CONFLICT', status: 409 },
  )
  assert.throws(() => bootstrapPsqlResult({ status: null, error: { code: 'ETIMEDOUT', message: secret } }), {
    code: 'PSQL_TIMEOUT',
  })
  assert.throws(() => bootstrapPsqlResult({ status: 125, stderr: secret }), { code: 'PSQL_UNAVAILABLE' })
})

test('native bootstrap reports allowlisted PostgreSQL states and last fixed checkpoint, never verbose context', async () => {
  const { bootstrapPsqlResult } = await bootstrapPsql
  const { bootstrapFailureMessage } = await import('../scripts/lib/bootstrap-feedback.mjs')
  const secret = 'private-hash-or-input-do-not-output'
  const result = {
    status: 3,
    stdout: 'LOTOS_BOOTSTRAP_STEP:transaction-start\nLOTOS_BOOTSTRAP_STEP:management-lock\n',
    stderr:
      'psql:<stdin>:28: NOTICE:  00000: LOTOS_BOOTSTRAP_STEP:credential-create\n' +
      'psql:<stdin>:28: ERROR:  42501: ' +
      secret +
      '\nCONTEXT: INSERT ' +
      secret +
      '\n',
  }
  let caught
  try {
    bootstrapPsqlResult(result)
  } catch (error) {
    caught = error
  }
  assert.equal(caught.code, 'PSQL_SQLSTATE_42501')
  assert.equal(caught.step, 'credential-create')
  const message = bootstrapFailureMessage(caught, { phase: 'creation' })
  assert.match(message, /42501/)
  assert.match(message, /credential-create/)
  assert.doesNotMatch(message, /private-hash|INSERT|CONTEXT/)
  assert.throws(
    () => bootstrapPsqlResult({ status: 3, stderr: 'psql:<stdin>:28: ERROR:  P0001: BOOTSTRAP_ALREADY_EXISTS\n' }),
    { code: 'CONFLICT' },
  )
  assert.throws(() => bootstrapPsqlResult({ status: 3, stderr: 'ERROR: SECRET: ' + secret }), { code: 'PSQL_FAILED' })
  assert.throws(
    () =>
      bootstrapPsqlResult({
        status: 2,
        stdout: 'LOTOS_BOOTSTRAP_STEP:transaction-guard\n',
        stderr: 'psql:<stdin>:5: FATAL:  25P03: ' + secret + '\n',
      }),
    { code: 'PSQL_SQLSTATE_25P03', step: 'transaction-guard' },
  )
  assert.throws(() => bootstrapPsqlResult({ signal: 'SIGKILL', stdout: 'LOTOS_BOOTSTRAP_STEP:transaction-commit\n' }), {
    code: 'PSQL_TIMEOUT',
    step: 'transaction-commit',
  })
})

test('native bootstrap owns bounded stdin-only commands and cleans precisely its labeled container', async () => {
  const { runBootstrapPsql } = await bootstrapPsql
  const values = { ...fixture(), BOOTSTRAP_CLOUD_ADMIN: 'explicit-operator' }
  const secretSql = 'fictional-owner-hash-stdin-only'
  const calls = []
  assert.throws(
    () =>
      runBootstrapPsql(values, secretSql, {
        run: (command, args, options) => {
          calls.push({ command, args, options })
          if (calls.length === 1) return { status: null, error: { code: 'ETIMEDOUT' } }
          if (calls.length === 2)
            return { status: 0, stdout: calls[0].args[calls[0].args.indexOf('--label') + 1].split('=')[1] + '\n' }
          return { status: 0, stdout: '' }
        },
      }),
    { code: 'PSQL_TIMEOUT' },
  )
  assert.equal(calls.length, 3)
  assert.equal(calls[0].options.input, secretSql)
  assert.equal(calls[0].options.timeout, 30000)
  assert.equal(calls[0].options.env.PGPASSWORD, '1'.repeat(64))
  assert.equal(calls[0].options.env.DIRECT_URL, undefined)
  assert.equal(calls[0].options.env.DEBUG, undefined)
  assert.ok(!calls[0].args.join(' ').includes(secretSql))
  const name = calls[0].args[calls[0].args.indexOf('--name') + 1]
  assert.equal(calls[2].args.at(-1), name)
  assert.ok(calls[2].args.includes('--force'))
  const caPath = calls[0].args[calls[0].args.indexOf('--mount') + 1].match(/source=([^,]+)/)[1]
  assert.equal(fs.existsSync(caPath), false)
})

test('read-only bootstrap check cannot write or remove a differently labeled container', async () => {
  const { runBootstrapPsql } = await bootstrapPsql
  const values = { ...fixture(), BOOTSTRAP_CLOUD_ADMIN: 'read-only-check' }
  const calls = []
  const run = (command, args, options) => {
    calls.push({ command, args, options })
    return calls.length === 1 ? { status: 0, stdout: '{}\n' } : { status: 0, stdout: 'not-this-invocation\n' }
  }
  assert.throws(() => runBootstrapPsql(values, 'INSERT forbidden', { run }), { code: 'PSQL_UNAVAILABLE' })
  assert.equal(calls.length, 0)
  assert.equal(runBootstrapPsql(values, 'SELECT 1;', { readOnly: true, run }), '{}\n')
  assert.match(calls[0].options.input, /^BEGIN TRANSACTION READ ONLY;/)
  assert.match(calls[0].options.input, /ROLLBACK;\n$/)
  assert.equal(calls.length, 2)
})
test('Supabase staging pins the project, session endpoint, custom role and CA', async () => {
  const { validateEnvironment, validateCloudMigration } = await environment
  const values = fixture()
  assert.equal(validateEnvironment(values, 'staging').database, 'postgres')
  assert.equal(validateCloudMigration(values).username, 'lotos_migrator.abcdefghijklmnopqrst')
  for (const patch of [
    { CLOUD_DATABASE_PROVIDER: 'arbitrary' },
    { CLOUD_DATABASE_ISOLATED: '' },
    { CLOUD_SUPABASE_PROJECT_REF: 'otherprojectabcdefgh' },
    { CLOUD_DATABASE_HOST: 'aws-1-eu-central-1.pooler.supabase.com' },
    { CLOUD_DATABASE_CA_BASE64: '' },
    { CLOUD_DATABASE_CA_BASE64: Buffer.from('not a certificate').toString('base64') },
    { CLOUD_DATABASE_CA_BASE64: values.CLOUD_DATABASE_CA_BASE64 + '=' },
    { DATABASE_URL: values.DATABASE_URL.replace(':6543/', ':6432/') },
    { DATABASE_URL: values.DATABASE_URL.replace('lotos_runtime.', 'postgres.') },
    { DATABASE_URL: values.DATABASE_URL.replace('/postgres?', '/lotos_crm_staging?') },
    { DATABASE_URL: values.DATABASE_URL.replace('verify-full', 'require') },
    { DATABASE_URL: values.DATABASE_URL + '&sslrootcert=/tmp/untrusted' },
    { DATABASE_URL: values.DATABASE_URL.replace('pooler.supabase.com', 'pooler.supabase.com.evil.test') },
    { APP_ENV: 'production' },
    { APP_ENV: 'local' },
    { VERCEL: '1', VERCEL_ENV: 'preview' },
  ])
    assert.throws(() => validateEnvironment({ ...values, ...patch }, 'staging'))
  // Old low-concurrency Session runtime remains valid; new Vercel template uses Transaction.
  assert.equal(
    validateEnvironment({ ...values, DATABASE_URL: values.DATABASE_URL.replace(':6543/', ':5432/') }, 'staging')
      .database,
    'postgres',
  )
})
test('Supabase migrations require the same project and separate non-owner credentials', async () => {
  const { validateCloudMigration } = await environment
  const values = fixture()
  for (const url of [
    values.DATABASE_URL,
    values.DIRECT_URL.replace('lotos_migrator.', 'postgres.'),
    values.DIRECT_URL.replace('abcdefghijklmnopqrst', 'zyxwvutsrqponmlkjihg'),
    values.DIRECT_URL.replace(':5432/', ':6543/'),
    values.DIRECT_URL.replace('2'.repeat(64), '1'.repeat(64)),
  ])
    assert.throws(() => validateCloudMigration({ ...values, DIRECT_URL: url }))
  const direct = values.DIRECT_URL.replace(
    'aws-0-eu-central-1.pooler.supabase.com',
    'db.abcdefghijklmnopqrst.supabase.co',
  ).replace('lotos_migrator.abcdefghijklmnopqrst', 'lotos_migrator')
  assert.equal(
    validateCloudMigration({
      ...values,
      DIRECT_URL: direct,
      CLOUD_DATABASE_DIRECT_HOST: 'db.abcdefghijklmnopqrst.supabase.co',
    }).username,
    'lotos_migrator',
  )
})
test('pg options retain the explicit CA instead of being overwritten by URL SSL parsing', async () => {
  const { runtimeDatabaseOptions } = await database
  const { parse } = require('pg-connection-string')
  const options = runtimeDatabaseOptions(fixture())
  assert.equal(parse(options.connectionString).ssl, undefined)
  assert.equal(options.ssl.rejectUnauthorized, true)
  assert.equal(options.ssl.ca, certificatePem)
  assert.equal(new URL(options.connectionString).hostname, fixture().CLOUD_DATABASE_HOST)
})
test('runtime TLS accepts the supplied CA and rejects a mismatched hostname on a real socket', async () => {
  const { runtimeDatabaseOptions } = await database
  const options = runtimeDatabaseOptions(fixture())
  const server = tls.createServer({ cert: certificatePem, key: fs.readFileSync(key) }, (socket) => socket.end())
  server.on('tlsClientError', () => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const connect = (servername) =>
    new Promise((resolve, reject) => {
      const client = tls.connect({ host: '127.0.0.1', port: server.address().port, servername, ...options.ssl })
      client.once('secureConnect', () => {
        client.destroy()
        resolve()
      })
      client.once('error', reject)
    })
  try {
    await connect('localhost')
    await assert.rejects(connect('wrong.fictional.test'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
test('Prisma migration CA is private, strictly configured and removed even after failure', async () => {
  const { validateCloudMigration } = await environment
  const { withCloudMigrationCertificate, prismaCloudMigrationUrl } = await migration
  let filename
  const values = fixture()
  assert.throws(() => prismaCloudMigrationUrl(values, validateCloudMigration(values)))
  assert.throws(
    () =>
      withCloudMigrationCertificate(values, (certificateEnv) => {
        filename = certificateEnv.CLOUD_MIGRATION_CA_FILE
        assert.equal(fs.statSync(filename).mode & 0o077, 0)
        const url = new URL(prismaCloudMigrationUrl({ ...values, ...certificateEnv }, validateCloudMigration(values)))
        assert.equal(url.searchParams.get('sslmode'), 'require')
        assert.equal(url.searchParams.get('sslaccept'), 'strict')
        assert.equal(url.searchParams.get('sslcert'), filename)
        assert.equal(fs.readFileSync(filename, 'utf8'), certificatePem)
        throw Error('fixture failure')
      }),
    /fixture failure/,
  )
  assert.equal(fs.existsSync(filename), false)
})
test('Prisma v7 loads the Supabase operator configuration with the generated certificate', async () => {
  const { withCloudMigrationCertificate } = await migration
  const { cloudChildEnvironment } = await import('../scripts/lib/cloud-environment.mjs')
  const values = fixture()
  withCloudMigrationCertificate(values, (certificateEnv) => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { loadConfigFromFile } from '@prisma/config';
      const loaded = await loadConfigFromFile({configFile:'prisma.vercel.config.ts', configRoot:process.cwd()});
      assert.equal(loaded.error, undefined);
      const url = new URL(loaded.config.datasource.url);
      assert.equal(url.searchParams.get('sslaccept'), 'strict');
      assert.equal(url.searchParams.get('sslcert'), process.env.CLOUD_MIGRATION_CA_FILE);
    `,
      ],
      { env: { ...cloudChildEnvironment(values), ...certificateEnv }, stdio: 'ignore', timeout: 15_000 },
    )
    assert.equal(result.status, 0, 'Prisma config loads without contacting any database')
  })
})
test('migration CA survives an asynchronous command and is removed after rejection', async () => {
  const { withCloudMigrationCertificate } = await migration
  let filename
  await assert.rejects(
    withCloudMigrationCertificate(fixture(), async (env) => {
      filename = env.CLOUD_MIGRATION_CA_FILE
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(fs.existsSync(filename), true)
      throw Error('fictional async failure')
    }),
    /fictional async failure/,
  )
  assert.equal(fs.existsSync(filename), false)
})
test('Supabase cloud preflight runs without resources or credentials in output', async () => {
  const { cloudChildEnvironment } = await import('../scripts/lib/cloud-environment.mjs')
  const child = spawnSync(process.execPath, ['scripts/cloud-check.mjs'], {
    env: cloudChildEnvironment(fixture()),
    encoding: 'utf8',
  })
  assert.equal(child.status, 0)
  const summary = JSON.parse(child.stdout)
  assert.equal(summary.databaseProvider, 'supabase')
  assert.equal(summary.liveResourcesVerified, false)
  assert.equal(summary.receiptsEnabled, false)
  assert.doesNotMatch(child.stdout + child.stderr, /postgresql:\/\/|BEGIN CERTIFICATE/)
})
