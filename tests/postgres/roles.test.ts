import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { Client } from 'pg'
import { validateEnvironment } from '../../scripts/lib/environment.mjs'

validateEnvironment(process.env, 'test')
const container = process.env.LOTOS_TEST_CONTAINER || ''
assert.match(container, /^lotos-crm-test-[a-f0-9]{12}-db-1$/)
const dockerEnv: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: 'unix:///var/run/docker.sock' }
delete dockerEnv.DOCKER_CONTEXT
const docker = (args: string[], input?: Buffer | string) =>
  execFileSync('docker', args, {
    env: dockerEnv,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000,
  })

test('deployment role bootstrap has real least-privilege runtime and read-only backup access', async () => {
  // A DIFFERENT database inside this random tmpfs TEST container, not staging.
  const root = new Client({ connectionString: process.env.DATABASE_URL })
  await root.connect()
  const sourceClients = (await root.query('SELECT count(*)::int AS count FROM clients')).rows[0].count
  const migrator = randomBytes(32).toString('hex'),
    runtime = randomBytes(32).toString('hex'),
    backup = randomBytes(32).toString('hex')
  const database = 'lotos_crm_staging'
  let created = false
  const clients: Client[] = []
  try {
    await root.query('CREATE DATABASE lotos_crm_staging')
    created = true
    const script = readFileSync('infra/postgres/001-roles.sh', 'utf8')
    // All values are validated hex/fixed identifiers; secrets use stdin.
    const environment = `export POSTGRES_DB=${database} POSTGRES_USER=lotos_test POSTGRES_PASSWORD=${process.env.POSTGRES_PASSWORD} RUNTIME_PASSWORD=${runtime} MIGRATOR_PASSWORD=${migrator} BACKUP_PASSWORD=${backup}\n`
    docker(['exec', '-i', container, 'sh'], environment + script)
    const dump = docker([
      'exec',
      container,
      'pg_dump',
      '-U',
      'lotos_test',
      '-d',
      'lotos_crm_test',
      '--format=custom',
      '--no-owner',
      '--no-acl',
    ])
    // Binary archive on stdin; no passwords in pg_restore args or model output.
    const migrationConnection = new Client({
      host: '127.0.0.1',
      port: 55433,
      database,
      user: 'lotos_migrator',
      password: migrator,
    })
    await migrationConnection.connect()
    clients.push(migrationConnection)
    docker(
      [
        'exec',
        '-i',
        container,
        'pg_restore',
        '-U',
        'lotos_migrator',
        '-d',
        'lotos_crm_staging',
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
      ],
      dump,
    )
    // Local Unix socket auth in this disposable official image is trust.
    // TCP tests below exercise the actual generated passwords/role boundaries.
    const runtimeConnection = new Client({
      host: '127.0.0.1',
      port: 55433,
      database,
      user: 'lotos_runtime',
      password: runtime,
    })
    const backupConnection = new Client({
      host: '127.0.0.1',
      port: 55433,
      database,
      user: 'lotos_backup',
      password: backup,
    })
    for (const client of [runtimeConnection, backupConnection]) {
      await client.connect()
      clients.push(client)
    }
    assert.equal(
      (await runtimeConnection.query('SELECT count(*)::int AS count FROM clients')).rows[0].count,
      sourceClients,
    )
    assert.equal(
      (await backupConnection.query('SELECT count(*)::int AS count FROM clients')).rows[0].count,
      sourceClients,
    )
    const rejectPrivilege = (error: unknown) =>
      !!error && typeof error === 'object' && 'code' in error && error.code === '42501'
    await assert.rejects(runtimeConnection.query('CREATE TABLE forbidden_runtime_ddl (id text)'), rejectPrivilege)
    await assert.rejects(runtimeConnection.query('ALTER TABLE audit_events DISABLE TRIGGER ALL'), rejectPrivilege)
    await assert.rejects(runtimeConnection.query('TRUNCATE payments'), rejectPrivilege)
    await assert.rejects(backupConnection.query('DELETE FROM clients'), rejectPrivilege)
    const privileges = (
      await runtimeConnection.query(
        'SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user',
      )
    ).rows[0]
    assert.deepEqual(privileges, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false })
    console.log(
      'ROLE_BOUNDARIES ' +
        JSON.stringify({ runtimeDdlRejected: true, backupReadOnly: true, passwordsTestedOverTcp: true }),
    )
  } finally {
    for (const client of clients) await client.end()
    if (created) {
      await root.query('DROP DATABASE lotos_crm_staging WITH (FORCE)')
      await root.query('DROP ROLE IF EXISTS lotos_runtime, lotos_backup, lotos_migrator')
    }
    await root.end()
  }
})
