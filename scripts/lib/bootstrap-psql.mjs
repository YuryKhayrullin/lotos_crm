import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { validateEnvironment } from './environment.mjs'
import { cloudDatabaseIdentity } from './cloud-database.mjs'
import { withCloudMigrationCertificate } from './cloud-migration-tls.mjs'

export class BootstrapTransportError extends Error {
  constructor(code, step) {
    super('Bootstrap transport failed; private details suppressed')
    this.name = 'BootstrapTransportError'
    this.code = code
    this.step = step
  }
}

export function bootstrapPsqlPlan(values, certificateFile, invocation = randomUUID()) {
  validateEnvironment(values, 'staging')
  if (
    values.APP_ENV !== 'staging' ||
    values.DEPLOY_TARGET !== 'vercel' ||
    values.CLOUD_DATABASE_PROVIDER !== 'supabase' ||
    !['explicit-operator', 'read-only-check'].includes(values.BOOTSTRAP_CLOUD_ADMIN) ||
    !/^[a-f0-9-]{36}$/.test(invocation)
  )
    throw new BootstrapTransportError('PSQL_UNAVAILABLE')
  const identity = cloudDatabaseIdentity(values)
  const url = new URL(values.DATABASE_URL)
  const name = 'lotos-owner-bootstrap-' + invocation
  return {
    name,
    invocation,
    identity,
    password: decodeURIComponent(url.password),
    args: [
      '--host',
      'unix:///var/run/docker.sock',
      'run',
      '--rm',
      '--pull=never',
      '-i',
      '--name',
      name,
      '--label',
      'lotos.owner-bootstrap=' + invocation,
      '--mount',
      `type=bind,source=${certificateFile},target=/tmp/lotos-ca.crt,readonly`,
      '-e',
      'PGPASSWORD',
      'postgres:17-bookworm',
      'psql',
      `host=${url.hostname} port=5432 dbname=${identity.database} user=${identity.username} sslmode=verify-full sslrootcert=/tmp/lotos-ca.crt connect_timeout=10 application_name=lotos-owner-bootstrap`,
      '-X',
      '-w',
      '-q',
      '-A',
      '-t',
      '--set=ON_ERROR_STOP=1',
      // Capture SQLSTATE, not raw errors. Verbose stderr is never forwarded.
      '--set=VERBOSITY=verbose',
      '--set=ECHO=none',
      '--file=-',
    ],
  }
}

export function bootstrapPsqlResult(result) {
  const steps = [
    'transaction-start',
    'transaction-guard',
    'management-lock',
    'admin-check',
    'user-create',
    'credential-create',
    'audit-create',
    'transaction-commit',
  ]
  const markers = (result.stdout || '') + '\n' + (result.stderr || '')
  const observed = new Set(
    Array.from(
      markers.matchAll(
        /(?:^|\n)(?:(?:psql:[^\n]*: )?NOTICE:\s+(?:00000:\s+)?)?LOTOS_BOOTSTRAP_STEP:([a-z-]+)\s*(?=\n|$)/g,
      ),
      (match) => match[1],
    ),
  )
  const step = steps.filter((value) => observed.has(value)).at(-1)
  if (result.error?.code === 'ETIMEDOUT' || result.signal) throw new BootstrapTransportError('PSQL_TIMEOUT', step)
  if (result.error || result.status === 125 || result.status === 127)
    throw new BootstrapTransportError('PSQL_UNAVAILABLE')
  if (result.status !== 0) {
    if (
      /(?:^|\n)(?:psql:[^\n]*: )?ERROR:\s+(?:P0001:\s+)?BOOTSTRAP_ALREADY_EXISTS\s*(?:\n|$)/.test(result.stderr || '')
    )
      throw Object.assign(Error('First administrator exists'), {
        name: 'PostgresApiError',
        code: 'CONFLICT',
        status: 409,
      })
    const state = (result.stderr || '').match(/(?:^|\n)(?:psql:[^\n]*: )?(?:ERROR|FATAL):\s+([0-9A-Z]{5}):/)?.[1]
    const safeStates = new Set([
      '08001',
      '08006',
      '08P01',
      '22021',
      '23502',
      '23503',
      '23505',
      '23514',
      '25006',
      '25P02',
      '25P03',
      '42501',
      '42601',
      '42703',
      '42804',
      '42883',
      '42P01',
      '53100',
      '53200',
      '53300',
      '53400',
      '57014',
      '57P01',
      '57P03',
      'P0001',
    ])
    throw new BootstrapTransportError(safeStates.has(state) ? 'PSQL_SQLSTATE_' + state : 'PSQL_FAILED', step)
  }
  return result.stdout || ''
}

export function runBootstrapPsql(values, sql, { readOnly = false, run = spawnSync } = {}) {
  if (process.platform !== 'linux') throw new BootstrapTransportError('PSQL_UNAVAILABLE')
  if (!readOnly && values.BOOTSTRAP_CLOUD_ADMIN !== 'explicit-operator')
    throw new BootstrapTransportError('PSQL_UNAVAILABLE')
  return withCloudMigrationCertificate(values, ({ CLOUD_MIGRATION_CA_FILE }) => {
    const plan = bootstrapPsqlPlan(values, CLOUD_MIGRATION_CA_FILE)
    // No debug/PGOPTIONS/remote Docker context inheritance; runtime password
    // is an environment value, SQL/hash stdin only. Never print child errors.
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' }
    const result = run('docker', plan.args, {
      env: { ...env, PGPASSWORD: plan.password },
      input: readOnly
        ? `BEGIN TRANSACTION READ ONLY;\nSET LOCAL idle_in_transaction_session_timeout='10s';\n${sql}\nROLLBACK;\n`
        : sql,
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
      maxBuffer: 65_536,
    })
    // Killing docker CLI alone can leave its container. Resolve only this
    // invocation's label before removing its disposable psql client.
    const inspected = run(
      'docker',
      [
        '--host',
        'unix:///var/run/docker.sock',
        'inspect',
        '--format',
        '{{index .Config.Labels "lotos.owner-bootstrap"}}',
        plan.name,
      ],
      { env, encoding: 'utf8', timeout: 5000 },
    )
    if (inspected.status === 0 && inspected.stdout.trim() === plan.invocation) {
      const cleanup = run('docker', ['--host', 'unix:///var/run/docker.sock', 'rm', '--force', plan.name], {
        env,
        encoding: 'utf8',
        timeout: 5000,
      })
      if (cleanup.status !== 0) throw new BootstrapTransportError('PSQL_CLEANUP')
    }
    return bootstrapPsqlResult(result)
  })
}
