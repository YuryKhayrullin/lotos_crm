import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { test, after, afterEach, before } from 'node:test'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { buildBootstrapSql, buildBootstrapSqlEditorSql, bootstrapPreflightSql } from '../../scripts/lib/bootstrap-sql'
import { bootstrapPsqlResult } from '../../scripts/lib/bootstrap-psql.mjs'
import { validateEnvironment } from '../../scripts/lib/environment.mjs'
import { createPostgresClient } from '../../lib/server/postgres/client'
import { createPostgresAuth } from '../../lib/server/postgres/auth'
import { createPostgresRouter } from '../../lib/server/postgres/http'

validateEnvironment(process.env, 'test')
const container = process.env.LOTOS_TEST_CONTAINER!
if (!/^lotos-crm-test-[a-f0-9]{12}-db-1$/.test(container)) throw Error('Disposable test container required')
const db = createPostgresClient(process.env)
const auth = createPostgresAuth(db, process.env)
const router = createPostgresRouter(db, auth, process.env)
const password = randomBytes(24).toString('hex')
let passwordHash: string

function psql(sql: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        container,
        'psql',
        '-X',
        '-w',
        '-q',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        'VERBOSITY=terse',
        '-U',
        process.env.POSTGRES_USER!,
        '-d',
        process.env.POSTGRES_DB!,
        '-f',
        '-',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let stdout = '',
      stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
    child.stdin.end(sql)
  })
}
function draft(username: string, name = 'Fictional native admin') {
  const result = buildBootstrapSql({ username, name, password }, passwordHash)
  return result
}
before(async () => {
  passwordHash = await hashPassword(password)
  assert.equal(await db.user.count(), 0)
})
afterEach(async () => {
  // This suite runs first on its empty, disposable Test DB. History correctly
  // rejects DELETE; reset test fixtures without disabling production triggers.
  await db.$executeRawUnsafe('TRUNCATE TABLE public.users CASCADE')
})
after(async () => {
  await db.$disconnect()
})

test('libpq preflight is read-only and reports an open auth-management lock', async () => {
  const result = await psql(`BEGIN TRANSACTION READ ONLY; ${bootstrapPreflightSql} ROLLBACK;`)
  assert.equal(result.status, 0)
  const report = JSON.parse(result.stdout.trim())
  assert.equal(report.admins, 0)
  assert.equal(report.authLockAvailable, true)
  assert.equal(await db.user.count(), 0)
})

test('SQL Editor fallback executes the same atomic bootstrap without psql metacommands', async () => {
  const item = buildBootstrapSqlEditorSql(
    { username: 'sql-editor-admin', name: 'SQL Editor admin', password },
    passwordHash,
  )
  assert.doesNotMatch(item.sql, /^\\/m)
  const result = await psql(item.sql)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /LOTOS_BOOTSTRAP_COMMITTED/)
  assert.equal(await db.user.count({ where: { role: 'admin' } }), 1)
  assert.equal(await db.account.count({ where: { providerId: 'credential' } }), 1)
  assert.equal(await db.auditEvent.count({ where: { action: 'bootstrapAdmin' } }), 1)
})

test('simultaneous native bootstraps commit exactly one user, credential and audit', async () => {
  const drafts = [draft('native-admin-one'), draft('native-admin-two')]
  const results = await Promise.all(drafts.map((item) => psql(item.sql)))
  assert.equal(results.filter((result) => result.status === 0).length, 1)
  const loser = results.find((result) => result.status !== 0)!
  assert.throws(() => bootstrapPsqlResult(loser), { code: 'CONFLICT' })
  assert.equal(await db.user.count({ where: { role: 'admin' } }), 1)
  assert.equal(await db.account.count({ where: { providerId: 'credential' } }), 1)
  assert.equal(await db.auditEvent.count({ where: { action: 'bootstrapAdmin' } }), 1)
  const credential = await db.account.findFirstOrThrow()
  assert.equal(await verifyPassword({ hash: credential.password!, password }), true)
})

test('native bootstrap credentials sign in through the unchanged Prisma/Better Auth HTTP facade', async () => {
  const item = draft('native-login-admin')
  assert.equal((await psql(item.sql)).status, 0)
  const request = new Request(process.env.APP_URL + '/api/auth/login', {
    method: 'POST',
    headers: { origin: process.env.APP_URL!, 'content-type': 'application/json' },
    body: JSON.stringify({ username: item.user.username, password }),
  })
  const response = await router(request, ['auth', 'login'])
  assert.equal(response.status, 200)
  assert.equal((await response.json()).user.id, item.user.id)
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.includes('HttpOnly')))
})

test('an existing admin is never replaced by a repeated native bootstrap', async () => {
  assert.equal((await psql(draft('native-existing-admin').sql)).status, 0)
  const before = await db.account.findFirstOrThrow()
  assert.notEqual((await psql(draft('native-unwanted-admin').sql)).status, 0)
  assert.equal(await db.user.count({ where: { role: 'admin' } }), 1)
  assert.equal((await db.account.findFirstOrThrow()).password, before.password)
})

test('an audit failure rolls back the native user and credential and releases the lock', async () => {
  const item = draft('native-rollback-admin')
  const failed = await psql(item.sql.replace("'bootstrapAdmin', 'user'", "'bootstrapAdmin', NULL"))
  assert.notEqual(failed.status, 0)
  assert.doesNotMatch(failed.stdout, /LOTOS_BOOTSTRAP_COMMITTED/)
  assert.equal(await db.user.count(), 0)
  assert.equal(await db.account.count(), 0)
  assert.equal(await db.auditEvent.count(), 0)
  const report = JSON.parse((await psql(bootstrapPreflightSql)).stdout.trim())
  assert.equal(report.authLockAvailable, true)
})

test('encoded names cannot inject SQL or psql metacommands', async () => {
  const name = "О'Брайен'); COMMIT; DROP TABLE public.users; --\n\\! echo NOT_A_COMMAND"
  const item = draft('native-safe-name', name)
  assert.ok(!item.sql.includes(name))
  assert.equal((await psql(item.sql)).status, 0)
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: item.user.id } })).name, name)
})

test('native bootstrap requires only runtime-like table permissions, not a schema owner', async () => {
  const role = 'native_bootstrap_test_role'
  const grants = await psql(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
    GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON public.users TO ${role};
    GRANT INSERT ON public.users, public.accounts, public.audit_events TO ${role};`)
  assert.equal(grants.status, 0)
  const item = draft('native-runtime-admin')
  assert.equal((await psql(`SET ROLE ${role};\n${item.sql}`)).status, 0)
  assert.equal(await db.user.count({ where: { id: item.user.id, role: 'admin' } }), 1)
})

test('native bootstrap transaction settings do not leak into session defaults', async () => {
  const item = draft('native-timeout-admin')
  const result = await psql(
    `SHOW idle_in_transaction_session_timeout;\n${item.sql}\nSHOW idle_in_transaction_session_timeout;`,
  )
  assert.equal(result.status, 0)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  assert.equal(lines[0], lines.at(-1))
})
