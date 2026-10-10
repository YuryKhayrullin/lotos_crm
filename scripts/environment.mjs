import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { environmentFile, parseEnv, validateEnvironment } from './lib/environment.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [action, environment] = process.argv.slice(2)

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.error || result.status !== 0)
    throw new Error('Command failed: ' + path.basename(binary) + ' (no credentials logged)')
  return result.stdout || ''
}

function compose() {
  if (process.env.LOTOS_COMPOSE_BIN) return { binary: process.env.LOTOS_COMPOSE_BIN, prefix: [] }
  const localBinary = path.join(root, '.tools', 'docker-compose')
  if (fs.existsSync(localBinary)) return { binary: localBinary, prefix: [] }
  run('docker', ['compose', 'version'])
  return { binary: 'docker', prefix: ['compose'] }
}

function valuesFromFile(expected) {
  const filename = path.join(root, environmentFile(expected))
  if (!fs.existsSync(filename))
    throw new Error('Missing ' + environmentFile(expected) + '; run env:init for local/test')
  const values = parseEnv(fs.readFileSync(filename, 'utf8'))
  validateEnvironment(values, expected)
  return values
}

function childEnvironment(values) {
  const inherited = { ...process.env }
  for (const name of Object.keys(inherited)) {
    if (
      /^(COMPOSE_|DOCKER_|POSTGRES_|PG|DATABASE_URL$|DIRECT_URL$|GAS_|SESSION_SECRET$|UPSTASH_|SMOKE_|DEPLOY_TARGET$|CLOUD_|BLOB_|VERCEL|NEXT_PUBLIC_VERCEL|DOCUMENT_STORAGE$|TRUSTED_PROXY$)/.test(
        name,
      )
    )
      delete inherited[name]
  }
  return {
    ...inherited,
    ...values,
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    GAS_WEBAPP_URL: '',
    GAS_HMAC_SECRET: '',
    SESSION_SECRET: '',
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: '',
  }
}

function initialize(expected) {
  if (!['local', 'test'].includes(expected)) throw new Error('Automatic setup is allowed only for local and test')
  const filename = path.join(root, environmentFile(expected))
  if (fs.existsSync(filename)) {
    valuesFromFile(expected)
    console.log(environmentFile(expected) + ' already exists and is valid; left unchanged')
    return
  }
  const password = crypto.randomBytes(32).toString('hex')
  const secret = crypto.randomBytes(32).toString('hex')
  const role = 'lotos_' + expected
  const database = 'lotos_crm_' + expected
  const port = expected === 'local' ? 55432 : 55433
  const values = {
    APP_ENV: expected,
    NODE_ENV: expected === 'test' ? 'test' : 'development',
    CRM_BACKEND: 'postgres',
    APP_URL: expected === 'test' ? 'http://127.0.0.1:3002' : 'http://localhost:3001',
    POSTGRES_DB: database,
    POSTGRES_USER: role,
    POSTGRES_PASSWORD: password,
    DATABASE_URL: `postgresql://${role}:${password}@127.0.0.1:${port}/${database}`,
    BETTER_AUTH_SECRET: secret,
  }
  validateEnvironment(values, expected)
  fs.writeFileSync(
    filename,
    Object.entries(values)
      .map(([key, value]) => key + '=' + value)
      .join('\n') + '\n',
    { flag: 'wx', mode: 0o600 },
  )
  console.log('Created private ' + environmentFile(expected) + '; no secrets printed')
}

const smokeSql = `
BEGIN;
CREATE TEMP TABLE isolation_probe (request_id text PRIMARY KEY, credits integer CHECK (credits >= 0));
INSERT INTO isolation_probe VALUES ('probe', 1);
INSERT INTO isolation_probe VALUES ('probe', 1) ON CONFLICT DO NOTHING;
SAVEPOINT before_change;
UPDATE isolation_probe SET credits = 0;
ROLLBACK TO before_change;
DO $$ BEGIN
  IF (SELECT count(*) FROM isolation_probe) <> 1 OR (SELECT credits FROM isolation_probe) <> 1
  THEN RAISE EXCEPTION 'Transaction probe failed'; END IF;
END $$;
COMMIT;
SELECT current_database();
`

try {
  if (Number(process.versions.node.split('.')[0]) !== 22)
    throw new Error('Use Node.js 22; exact project version is in .nvmrc')
  if (action === 'init') {
    if (environment) initialize(environment)
    else {
      initialize('local')
      initialize('test')
    }
  } else {
    const values = valuesFromFile(environment)
    const summary = validateEnvironment(values, environment)
    if (action === 'check') console.log(JSON.stringify(summary))
    else {
      if (action === 'documents-inspect') {
        if (environment !== 'local' || process.argv.slice(2).length !== 2)
          throw new Error('Document inspection is restricted to local')
        run(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/inspect-documents.ts'], {
          env: childEnvironment(values),
          stdio: 'inherit',
        })
        process.exit(0)
      }
      if (action === 'import-test') {
        if (environment !== 'local') throw new Error('Test imports are restricted to local')
        run(
          process.execPath,
          ['--conditions=react-server', '--import', 'tsx', 'scripts/import-test.ts', ...process.argv.slice(4)],
          { env: childEnvironment(values), stdio: 'inherit' },
        )
        process.exit(0)
      }
      if (action === 'bootstrap' || action === 'dev') {
        if (environment !== 'local') throw new Error('Application launch/bootstrap is restricted to local')
        if (process.argv.slice(2).length !== 2)
          throw new Error('Extra launch/bootstrap arguments are forbidden; passwords are entered only interactively')
        const appEnv = childEnvironment(values)
        if (action === 'bootstrap') {
          run(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/bootstrap-admin.ts'], {
            env: appEnv,
            stdio: 'inherit',
          })
        } else {
          const port = new URL(values.APP_URL).port
          if (!port) throw new Error('APP_URL requires an explicit local port')
          run(process.execPath, ['node_modules/prisma/build/index.js', 'generate'], { env: appEnv })
          run(
            process.execPath,
            ['node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', port],
            { env: appEnv, stdio: 'inherit' },
          )
        }
        process.exit(0)
      }
      if (['generate', 'validate', 'migrate', 'format'].includes(action)) {
        if (environment !== 'local') throw new Error('Prisma CLI actions require the local environment')
        const prisma = path.join(root, 'node_modules/prisma/build/index.js')
        const command = {
          generate: ['generate'],
          validate: ['validate'],
          migrate: ['migrate', 'deploy'],
          format: ['format'],
        }[action]
        run(process.execPath, [prisma, ...command], { env: childEnvironment(values) })
        console.log('Prisma ' + action + ' completed in isolated local environment')
        process.exit(0)
      }
      if (
        environment !== 'local' &&
        !(
          environment === 'test' &&
          ['test', 'integration', 'auth-test', 'domain-test', 'auth-http', 'auth-browser', 'operations-test'].includes(
            action,
          )
        )
      )
        throw new Error('Docker actions are allowed only for local or disposable tests')
      if (
        ![
          'up',
          'status',
          'stop',
          'test',
          'integration',
          'auth-test',
          'domain-test',
          'auth-http',
          'auth-browser',
          'operations-test',
        ].includes(action)
      )
        throw new Error('Unknown environment action')
      if (
        ['test', 'integration', 'auth-test', 'domain-test', 'auth-http', 'auth-browser', 'operations-test'].includes(
          action,
        ) !==
        (environment === 'test')
      )
        throw new Error('Test execution requires the explicit test environment')
      const driver = compose()
      const project =
        environment === 'test' ? 'lotos-crm-test-' + crypto.randomBytes(6).toString('hex') : 'lotos-crm-local'
      const args = [
        ...driver.prefix,
        '--project-name',
        project,
        '--file',
        path.join(root, 'infra/compose.' + environment + '.yaml'),
        '--env-file',
        path.join(root, environmentFile(environment)),
      ]
      const options = { env: childEnvironment(values), stdio: ['pipe', 'inherit', 'inherit'] }
      if (action === 'up') run(driver.binary, [...args, 'up', '--detach', '--wait', '--wait-timeout', '90'], options)
      else if (action === 'status') run(driver.binary, [...args, 'ps'], options)
      else if (action === 'stop') run(driver.binary, [...args, 'stop'], options)
      else {
        try {
          run(driver.binary, [...args, 'up', '--detach', '--wait', '--wait-timeout', '90'], options)
          run(
            driver.binary,
            [
              ...args,
              'exec',
              '-T',
              'db',
              'psql',
              '-v',
              'ON_ERROR_STOP=1',
              '-U',
              values.POSTGRES_USER,
              '-d',
              values.POSTGRES_DB,
            ],
            { ...options, input: smokeSql },
          )
          if (
            ['integration', 'auth-test', 'domain-test', 'auth-http', 'auth-browser', 'operations-test'].includes(action)
          ) {
            const documentsRoot = fs.mkdtempSync('/tmp/lotos-crm-documents-test-')
            fs.chmodSync(documentsRoot, 0o700)
            const testEnv = { ...childEnvironment(values), NODE_ENV: 'test', DOCUMENTS_DIR: documentsRoot }
            testEnv.AUTH_BROWSER_TESTS = action === 'auth-browser' ? 'true' : 'false'
            if (action === 'operations-test' || action === 'auth-test') testEnv.LOTOS_TEST_CONTAINER = project + '-db-1'
            if (!testEnv.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(path.join(root, '.tools/playwright')))
              testEnv.PLAYWRIGHT_BROWSERS_PATH = path.join(root, '.tools/playwright')
            const prisma = path.join(root, 'node_modules/prisma/build/index.js')
            try {
              run(process.execPath, [prisma, 'generate'], { env: testEnv })
              // Applying twice checks a fresh install and the migration history.
              for (let attempt = 0; attempt < 2; attempt++)
                run(process.execPath, [prisma, 'migrate', 'deploy'], { env: testEnv })
              if (action === 'auth-test')
                run(
                  process.execPath,
                  ['--conditions=react-server', '--import', 'tsx', '--test', 'tests/postgres/bootstrap-libpq.test.ts'],
                  { env: testEnv, stdio: ['ignore', 'inherit', 'inherit'] },
                )
              run(
                process.execPath,
                [
                  '--conditions=react-server',
                  '--import',
                  'tsx',
                  '--test',
                  '--test-concurrency=1',
                  ...(testEnv.LOTOS_TEST_NAME_PATTERN ? ['--test-name-pattern', testEnv.LOTOS_TEST_NAME_PATTERN] : []),
                  action === 'operations-test'
                    ? 'tests/postgres/performance.test.ts'
                    : action === 'auth-http' || action === 'auth-browser'
                      ? 'tests/postgres/auth-http.test.ts'
                      : action === 'domain-test'
                        ? 'tests/postgres/domain.test.ts'
                        : action === 'auth-test'
                          ? 'tests/postgres/auth.test.ts'
                          : 'tests/postgres/foundation.test.ts',
                  ...(action === 'domain-test'
                    ? [
                        'tests/postgres/schedule-attendance.test.ts',
                        'tests/postgres/accounting.test.ts',
                        'tests/postgres/documents.test.ts',
                        'tests/postgres/blob-storage.test.ts',
                        'tests/postgres/import.test.ts',
                        'tests/postgres/recovery.test.ts',
                      ]
                    : []),
                  ...(action === 'operations-test'
                    ? [
                        'tests/postgres/supabase-roles.test.ts',
                        'tests/postgres/roles.test.ts',
                        'tests/postgres/restore.test.ts',
                      ]
                    : []),
                ],
                {
                  env: testEnv,
                  stdio: ['ignore', 'inherit', 'inherit'],
                },
              )
            } finally {
              // Only this invocation's mkdtemp-owned directory, never an env-supplied root.
              fs.rmSync(documentsRoot, { recursive: true })
            }
            console.log('Disposable PostgreSQL migrations and foundation integration checks passed')
          } else console.log('Disposable PostgreSQL checks passed; not a CRM integration test yet')
        } finally {
          // Only this invocation's random project; no shared volume and no -v.
          run(driver.binary, [...args, 'down'], options)
        }
      }
    }
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
