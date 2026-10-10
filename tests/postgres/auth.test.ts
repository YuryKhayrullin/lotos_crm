import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { validateEnvironment } from '../../scripts/lib/environment.mjs'
import { createPostgresClient } from '../../lib/server/postgres/client'
import { createPostgresAuth } from '../../lib/server/postgres/auth'
import { apiUser, requireActor, authorizeAction } from '../../lib/server/postgres/access'
import { bootstrapAdmin, mutateCoachAccount } from '../../lib/server/postgres/accounts'
import { createPostgresRouter } from '../../lib/server/postgres/http'
import { incrementAuthBucket, trustedClientIp } from '../../lib/server/postgres/rate-limit'

test('only explicit Vercel staging on the platform trusts its overwritten IP header', () => {
  const headers = new Headers({
    'x-vercel-forwarded-for': '198.51.100.7',
    'x-forwarded-for': '192.0.2.99',
    'x-lotos-client-ip': '192.0.2.99',
  })
  const values: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    APP_ENV: 'staging',
    DEPLOY_TARGET: 'vercel',
    TRUSTED_PROXY: 'vercel',
    VERCEL: '1',
  }
  assert.equal(trustedClientIp(headers, values), '198.51.100.7')
  assert.equal(trustedClientIp(headers, { ...values, VERCEL: undefined }), 'unknown')
  assert.equal(trustedClientIp(headers, { ...values, DEPLOY_TARGET: 'self-hosted' }), 'unknown')
  assert.equal(trustedClientIp(headers, { ...values, APP_ENV: 'local' }), 'unknown')
  assert.equal(
    trustedClientIp(new Headers({ 'x-vercel-forwarded-for': '198.51.100.7, 192.0.2.99' }), values),
    'unknown',
  )
})
import { hashPassword as legacyHashPassword } from '../../lib/server/passwords'

validateEnvironment(process.env, 'test')
const values: NodeJS.ProcessEnv = { ...process.env, COACH_REGISTRATION_ENABLED: 'true' }
const db = createPostgresClient(values)
const auth = createPostgresAuth(db, values)
const route = createPostgresRouter(db, auth, values)
const password = randomBytes(24).toString('hex')
const branch = randomUUID(),
  otherBranch = randomUUID()
let adminUsername: string, adminId: string, adminCookie: string
let bootstrapResults: PromiseSettledResult<{ id: string; username: string }>[]

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
}
function request(path: string, body?: unknown, cookie = '', headers: Record<string, string> = {}) {
  return new Request(values.APP_URL + '/api/' + path, {
    method: path === 'auth/session' ? 'GET' : 'POST',
    headers: { origin: values.APP_URL!, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const call = (path: string, body?: unknown, cookie = '', headers?: Record<string, string>) =>
  route(request(path, body, cookie, headers), path.split('/'))
const crm = (action: string, payload: unknown, cookie = adminCookie) => call('crm', { action, payload }, cookie)
async function signIn(username: string, pass = password) {
  const response = await call('auth/login', { username, password: pass })
  assert.equal(response.status, 200, 'valid test login')
  return { response, cookie: cookies(response) }
}
async function coachFixture(
  options: { status?: 'pending' | 'active' | 'disabled'; branchId?: string | null; profile?: boolean } = {},
) {
  const username = 'coach-' + randomUUID().slice(0, 8)
  const user = await db.user.create({
    data: {
      username,
      name: username,
      status: options.status || 'active',
      branchId: options.branchId === undefined ? branch : options.branchId,
    },
  })
  await db.account.create({
    data: { userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) },
  })
  const coach =
    options.profile && user.branchId
      ? await db.coach.create({
          data: {
            name: username,
            userId: user.id,
            branchId: user.branchId,
            memberships: { create: { branchId: user.branchId } },
          },
        })
      : null
  return { user, coach, username }
}

before(async () => {
  bootstrapResults = await Promise.allSettled([
    bootstrapAdmin(db, { username: 'test-admin-one', name: 'Test administrator', password }),
    bootstrapAdmin(db, { username: 'test-admin-two', name: 'Test administrator', password }),
  ])
  const winner = bootstrapResults.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<{
    id: string
    username: string
  }>
  adminUsername = winner.value.username
  adminId = winner.value.id
  await db.branch.createMany({
    data: [
      { id: branch, name: 'Fictional pool A', address: 'Test address' },
      { id: otherBranch, name: 'Fictional pool B', address: 'Test address' },
    ],
  })
  adminCookie = (await signIn(adminUsername)).cookie
})
beforeEach(async () => {
  await db.authRateBucket.deleteMany()
})
after(async () => {
  await db.$disconnect()
})

test('concurrent bootstrap creates exactly one administrator and blocks every subsequent bootstrap', async () => {
  assert.equal(bootstrapResults.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(await db.user.count({ where: { role: 'admin' } }), 1)
  await assert.rejects(bootstrapAdmin(db, { username: 'third-admin', name: 'Not allowed', password }))
  assert.equal(await db.auditEvent.count({ where: { action: 'bootstrapAdmin' } }), 1)
})

test('login preserves the existing UI contract without returning token, password or internal auth version', async () => {
  const response = await call('auth/login', { username: adminUsername.toUpperCase(), password })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    status: 'success',
    user: { id: adminId, username: adminUsername, role: 'admin', branchId: null },
  })
  assert.ok(
    response.headers.getSetCookie().some((cookie) => cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax')),
  )
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith('lotos_crm_session=;')))
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('missing, forged and old GAS cookies cannot authorize PostgreSQL requests', async () => {
  for (const cookie of ['', 'lotos.session_token=forged', 'lotos_crm_session=legacy-jwt']) {
    const response = await call('auth/session', undefined, cookie)
    assert.equal(response.status, 401)
    assert.equal((await response.json()).authenticated, false)
    assert.equal((await crm('getUsers', {}, cookie)).status, 401)
  }
})

test('logout removes the server session and both new/legacy browser identities are cleared', async () => {
  const logged = await signIn(adminUsername)
  const response = await call('auth/logout', undefined, logged.cookie)
  assert.equal(response.status, 200)
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith('lotos.session_token=;')))
  assert.equal((await call('auth/session', undefined, logged.cookie)).status, 401)
  assert.equal((await call('auth/logout', undefined, logged.cookie)).status, 200)
})

test('registration creates only a pending coach without a session, branch or invented email', async () => {
  const input = { username: 'pending-public', password, requestId: randomUUID() }
  const response = await call('auth/register', input, adminCookie)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'success', pending: true })
  assert.equal(response.headers.getSetCookie().length, 0)
  const user = await db.user.findUniqueOrThrow({ where: { username: input.username } })
  assert.equal(user.role, 'coach')
  assert.equal(user.status, 'pending')
  assert.equal(user.branchId, null)
  assert.equal(user.email, null)
  assert.equal(await db.session.count({ where: { userId: user.id } }), 0)
  assert.equal((await call('auth/login', { username: input.username, password })).status, 401)
  assert.equal((await call('auth/session', undefined, adminCookie)).status, 200)
})

test('registration retries are durable and conflicting payloads never change a credential', async () => {
  const input = { username: 'registration-retry', password, requestId: randomUUID() }
  assert.equal((await call('auth/register', input)).status, 200)
  assert.equal((await call('auth/register', input)).status, 200)
  assert.equal((await call('auth/register', { ...input, password: password + '-changed' })).status, 409)
  assert.equal(await db.user.count({ where: { username: input.username } }), 1)
  const user = await db.user.findUniqueOrThrow({ where: { username: input.username } })
  const credential = await db.account.findFirstOrThrow({ where: { userId: user.id } })
  assert.equal(await verifyPassword({ password, hash: credential.password! }), true)
})

test('browser-supplied role, branch, status and passwordHash are rejected', async () => {
  for (const extra of [{ role: 'admin' }, { status: 'active' }, { branchId: branch }, { passwordHash: 'untrusted' }]) {
    const response = await call('auth/register', {
      username: 'forged-registration',
      password,
      requestId: randomUUID(),
      ...extra,
    })
    assert.equal(response.status, 400)
  }
  assert.equal(await db.user.count({ where: { username: 'forged-registration' } }), 0)
})

test('registration is a deliberate feature flag and raw Better Auth routes are not public', async () => {
  const disabled = createPostgresRouter(db, auth, { ...values, COACH_REGISTRATION_ENABLED: 'false' })
  assert.equal(
    (
      await disabled(
        request('auth/register', { username: 'disabled-registration', password, requestId: randomUUID() }),
        ['auth', 'register'],
      )
    ).status,
    403,
  )
  for (const endpoint of [
    'sign-up/email',
    'reset-password',
    'change-password',
    'update-user',
    'update-session',
    'sign-in/username',
  ])
    assert.equal(
      (
        await route(request('auth/' + endpoint, { role: 'admin', password }, adminCookie), [
          'auth',
          ...endpoint.split('/'),
        ])
      ).status,
      404,
    )
})

test('pending and disabled logins use the same public rejection as incorrect credentials', async () => {
  for (const status of ['pending', 'disabled'] as const) {
    const fixture = await coachFixture({ status })
    const response = await call('auth/login', { username: fixture.username, password })
    assert.equal(response.status, 401)
    assert.equal((await response.json()).message, 'Неверный логин или пароль')
    assert.equal(await db.session.count({ where: { userId: fixture.user.id } }), 0)
  }
  const response = await call('auth/login', { username: adminUsername, password: password + '-wrong' })
  assert.equal(response.status, 401)
})

test('an active but unassigned coach cannot receive a usable session', async () => {
  const fixture = await coachFixture({ branchId: null })
  assert.equal((await call('auth/login', { username: fixture.username, password })).status, 403)
  assert.equal(await db.session.count({ where: { userId: fixture.user.id } }), 0)
})

test('direct coach API calls cannot manage accounts, finance, clients or physically delete lessons', async () => {
  const fixture = await coachFixture()
  const { cookie } = await signIn(fixture.username)
  for (const action of [
    'getUsers',
    'assignUserBranch',
    'deactivateUser',
    'activateUser',
    'resetCoachPassword',
    'revokeUserSessions',
    'createCoach',
    'createClient',
    'getFinanceSummary',
    'recordPayment',
    'deleteLesson',
  ])
    assert.equal((await crm(action, { userId: fixture.user.id, requestId: randomUUID() }, cookie)).status, 403, action)
  assert.equal((await crm('createLesson', {}, cookie)).status, 400) // Schema rejects a missing payload; no GAS fallback.
  assert.equal((await crm('updateLesson', {}, cookie)).status, 400) // Ownership is checked against the assigned profile.
})

test('implemented accounting validates its input rather than returning fake success or calling GAS', async () => {
  const response = await crm('recordPayment', { requestId: randomUUID() })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'VALIDATION')
  assert.equal((await crm('getAuthUser', { username: adminUsername })).status, 400)
  assert.equal((await crm('unknown-action', {})).status, 400)
})

test('pending activation needs a real branch and registration does not activate by itself', async () => {
  const fixture = await coachFixture({ status: 'pending', branchId: null })
  assert.equal((await crm('activateUser', { userId: fixture.user.id, requestId: randomUUID() })).status, 403)
  assert.equal(
    (await crm('assignUserBranch', { userId: fixture.user.id, branchId: randomUUID(), requestId: randomUUID() }))
      .status,
    404,
  )
  assert.equal(
    (await crm('assignUserBranch', { userId: fixture.user.id, branchId: branch, requestId: randomUUID() })).status,
    200,
  )
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: fixture.user.id } })).status, 'pending')
  assert.equal((await crm('activateUser', { userId: fixture.user.id, requestId: randomUUID() })).status, 200)
  const { response } = await signIn(fixture.username)
  assert.equal((await response.json()).user.role, 'coach')
})

test('deactivation revokes all devices; later activation does not resurrect old cookies', async () => {
  const fixture = await coachFixture()
  const first = await signIn(fixture.username),
    second = await signIn(fixture.username)
  const before = await db.user.findUniqueOrThrow({ where: { id: fixture.user.id } })
  assert.equal((await crm('deactivateUser', { userId: fixture.user.id, requestId: randomUUID() })).status, 200)
  assert.equal(await db.session.count({ where: { userId: fixture.user.id } }), 0)
  for (const cookie of [first.cookie, second.cookie])
    assert.equal((await call('auth/session', undefined, cookie)).status, 401)
  assert.equal((await crm('activateUser', { userId: fixture.user.id, requestId: randomUUID() })).status, 200)
  assert.equal((await call('auth/session', undefined, first.cookie)).status, 401)
  assert.ok((await db.user.findUniqueOrThrow({ where: { id: fixture.user.id } })).authVersion > before.authVersion)
  await signIn(fixture.username)
})

test('old deactivate/activate replays cannot undo newer administrative changes', async () => {
  const fixture = await coachFixture()
  const disable = { userId: fixture.user.id, requestId: randomUUID() },
    activate = { userId: fixture.user.id, requestId: randomUUID() }
  assert.equal((await crm('deactivateUser', disable)).status, 200)
  assert.equal((await crm('activateUser', activate)).status, 200)
  assert.equal((await crm('deactivateUser', disable)).status, 200)
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: fixture.user.id } })).status, 'active')
  await crm('deactivateUser', { userId: fixture.user.id, requestId: randomUUID() })
  await crm('activateUser', activate)
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: fixture.user.id } })).status, 'disabled')
})

test('reset uses Better Auth hashes, revokes all sessions and accepts only the new password', async () => {
  const fixture = await coachFixture()
  const { cookie } = await signIn(fixture.username)
  const newPassword = randomBytes(24).toString('hex')
  assert.equal(
    (await crm('resetCoachPassword', { userId: fixture.user.id, newPassword, requestId: randomUUID() })).status,
    200,
  )
  assert.equal((await call('auth/session', undefined, cookie)).status, 401)
  assert.equal((await call('auth/login', { username: fixture.username, password })).status, 401)
  await signIn(fixture.username, newPassword)
  const audit = await db.auditEvent.findFirstOrThrow({
    where: { action: 'resetCoachPassword', entityId: fixture.user.id },
  })
  assert.ok(audit.changedFields.includes('password'))
  assert.equal(JSON.stringify(audit).includes(newPassword), false)
  assert.equal(JSON.stringify(await db.mutationRequest.findMany()).includes(newPassword), false)
})

test('old password reset replay never overwrites a more recent password', async () => {
  const fixture = await coachFixture()
  const older = { userId: fixture.user.id, newPassword: randomBytes(24).toString('hex'), requestId: randomUUID() }
  const newer = { userId: fixture.user.id, newPassword: randomBytes(24).toString('hex'), requestId: randomUUID() }
  await crm('resetCoachPassword', older)
  await crm('resetCoachPassword', newer)
  const version = (await db.user.findUniqueOrThrow({ where: { id: fixture.user.id } })).authVersion
  const response = await crm('resetCoachPassword', older)
  assert.equal((await response.json()).duplicate, true)
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: fixture.user.id } })).authVersion, version)
  await signIn(fixture.username, newer.newPassword)
})

test('password verification racing a reset cannot issue a cookie for stale credentials', async () => {
  const fixture = await coachFixture()
  const newPassword = randomBytes(24).toString('hex')
  const delayed = {
    ...auth,
    handler: async (req: Request) => {
      const response = await auth.handler(req)
      if (new URL(req.url).pathname.endsWith('sign-in/username') && response.ok) {
        await crm('resetCoachPassword', { userId: fixture.user.id, newPassword, requestId: randomUUID() })
      }
      return response
    },
  }
  const guarded = createPostgresRouter(db, delayed, values)
  const response = await guarded(request('auth/login', { username: fixture.username, password }), ['auth', 'login'])
  assert.equal(response.status, 401)
  assert.equal(response.headers.getSetCookie().length, 0)
  assert.equal(await db.session.count({ where: { userId: fixture.user.id } }), 0)
  await signIn(fixture.username, newPassword)
})

test('explicit session revocation is durable and its old retry does not log out a newer login', async () => {
  const fixture = await coachFixture()
  const first = await signIn(fixture.username)
  const revoke = { userId: fixture.user.id, requestId: randomUUID() }
  await crm('revokeUserSessions', revoke)
  assert.equal((await call('auth/session', undefined, first.cookie)).status, 401)
  const second = await signIn(fixture.username)
  await crm('revokeUserSessions', revoke)
  assert.equal((await call('auth/session', undefined, second.cookie)).status, 200)
})

test('branch assignment synchronizes the linked profile, revokes sessions and preserves history', async () => {
  const fixture = await coachFixture({ profile: true })
  const signed = await signIn(fixture.username)
  const lesson = await db.lesson.create({
    data: {
      coachId: fixture.coach!.id,
      branchId: branch,
      createdById: adminId,
      title: 'Historic lesson',
      category: 'swimming',
      localDate: new Date('2026-10-07'),
      timeZone: 'Europe/Moscow',
      startsAt: new Date('2026-10-07T14:00:00Z'),
      endsAt: new Date('2026-10-07T15:00:00Z'),
    },
  })
  const transfer = { userId: fixture.user.id, branchId: otherBranch, requestId: randomUUID() }
  assert.equal((await crm('assignUserBranch', transfer)).status, 200)
  assert.equal((await call('auth/session', undefined, signed.cookie)).status, 401)
  assert.equal((await db.coach.findUniqueOrThrow({ where: { id: fixture.coach!.id } })).branchId, otherBranch)
  assert.equal((await db.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).branchId, branch)
  await crm('assignUserBranch', { userId: fixture.user.id, branchId: branch, requestId: randomUUID() })
  await crm('assignUserBranch', transfer)
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: fixture.user.id } })).branchId, branch)
})

test('the current role is authoritative, not the role resolved before a transaction', async () => {
  const fixture = await coachFixture()
  const { cookie } = await signIn(fixture.username)
  const actor = await requireActor(db, auth, new Headers({ cookie }))
  await assert.rejects(
    mutateCoachAccount(
      db,
      { ...actor, role: 'admin' },
      'deactivateUser',
      { userId: fixture.user.id, requestId: randomUUID() },
      values.BETTER_AUTH_SECRET!,
    ),
  )
  await db.user.update({ where: { id: adminId }, data: { role: 'coach', branchId: branch } })
  try {
    assert.equal((await crm('getUsers', {})).status, 403)
  } finally {
    await db.user.update({ where: { id: adminId }, data: { role: 'admin', branchId: null } })
  }
})

test('canonical branch and server allowlist prevent data leakage after a branch change', async () => {
  const fixture = await coachFixture()
  const { cookie } = await signIn(fixture.username)
  await db.client.create({
    data: {
      branchId: otherBranch,
      childName: 'Visible test child',
      parentName: 'PRIVATE-PARENT',
      phone: 'PRIVATE-PHONE',
      paidAmountMinor: BigInt(1234567),
    },
  })
  await db.client.create({ data: { branchId: branch, childName: 'Other branch child', parentName: 'PRIVATE-OTHER' } })
  await db.user.update({ where: { id: fixture.user.id }, data: { branchId: otherBranch } })
  const session = await call('auth/session', undefined, cookie)
  assert.equal((await session.json()).user.branchId, otherBranch)
  const boot = await crm('getBootstrapData', { branchId: branch }, cookie)
  const data = await boot.json()
  assert.equal(data.branches.length, 1)
  assert.equal(data.branches[0].id, otherBranch)
  assert.equal('coachAccounts' in data, false)
  const summary = await crm('getDashboardSummary', { branchId: branch }, cookie)
  const text = await summary.text()
  assert.ok(text.includes('Visible test child'))
  assert.equal(text.includes('Other branch child'), false)
  for (const privateValue of ['PRIVATE-PARENT', 'PRIVATE-PHONE', '1234567'])
    assert.equal(text.includes(privateValue), false)
})

test('expired sessions and version-mismatched rows are rejected even if the signed cookie is intact', async () => {
  const fixture = await coachFixture()
  const logged = await signIn(fixture.username)
  await db.user.update({ where: { id: fixture.user.id }, data: { authVersion: { increment: 1 } } })
  assert.equal((await call('auth/session', undefined, logged.cookie)).status, 401)
  const next = await signIn(fixture.username)
  await db.session.updateMany({ where: { userId: fixture.user.id }, data: { expiresAt: new Date(0) } })
  assert.equal((await call('auth/session', undefined, next.cookie)).status, 401)
})

test('request conflicts and malformed administrative payloads never apply a partial mutation', async () => {
  const fixture = await coachFixture()
  const payload = { userId: fixture.user.id, requestId: randomUUID() }
  await crm('revokeUserSessions', payload)
  assert.equal((await crm('deactivateUser', payload)).status, 409)
  for (const extra of [{ role: 'admin' }, { authVersion: 100 }, { passwordHash: 'attacker-hash' }])
    assert.equal((await crm('deactivateUser', { ...payload, requestId: randomUUID(), ...extra })).status, 400)
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: fixture.user.id } })).status, 'active')
  assert.equal((await crm('deactivateUser', { userId: adminId, requestId: randomUUID() })).status, 403)
})

test('simultaneous duplicate account mutations commit one version change and one audit event', async () => {
  const fixture = await coachFixture()
  const payload = { userId: fixture.user.id, requestId: randomUUID() }
  const responses = await Promise.all([crm('deactivateUser', payload), crm('deactivateUser', payload)])
  assert.ok(responses.every((response) => response.status === 200))
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: fixture.user.id } })).authVersion, 2)
  assert.equal(await db.mutationRequest.count({ where: { actorId: adminId, requestKey: payload.requestId } }), 1)
  assert.equal(await db.auditEvent.count({ where: { entityId: fixture.user.id, action: 'deactivateUser' } }), 1)
})

test('an audit failure rolls back status, version, sessions and the durable confirmation', async () => {
  const fixture = await coachFixture()
  const logged = await signIn(fixture.username)
  const payload = { userId: fixture.user.id, requestId: randomUUID() }
  await db.$executeRawUnsafe(
    `CREATE FUNCTION auth_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$`,
  )
  await db.$executeRawUnsafe(
    `CREATE TRIGGER auth_test_reject_audit BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.entity_id = '${fixture.user.id}') EXECUTE FUNCTION auth_test_reject_audit()`,
  )
  try {
    assert.equal((await crm('deactivateUser', payload)).status, 503)
    const user = await db.user.findUniqueOrThrow({ where: { id: fixture.user.id } })
    assert.equal(user.status, 'active')
    assert.equal(user.authVersion, 1)
    assert.equal((await call('auth/session', undefined, logged.cookie)).status, 200)
    assert.equal(await db.mutationRequest.count({ where: { requestKey: payload.requestId } }), 0)
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER auth_test_reject_audit ON audit_events')
    await db.$executeRawUnsafe('DROP FUNCTION auth_test_reject_audit()')
  }
})

test('cross-origin, missing-origin and browser-fetch forgery cannot mutate account state', async () => {
  const fixture = await coachFixture()
  for (const headers of [
    { origin: 'https://evil.example' },
    { origin: '' },
    { 'sec-fetch-site': 'cross-site' },
  ] as Record<string, string>[])
    assert.equal(
      (
        await call(
          'crm',
          { action: 'deactivateUser', payload: { userId: fixture.user.id, requestId: randomUUID() } },
          adminCookie,
          headers,
        )
      ).status,
      403,
    )
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: fixture.user.id } })).status, 'active')
})

test('raw body bytes are bounded before JSON parsing, including unknown content length', async () => {
  const large = new Request(values.APP_URL + '/api/auth/login', {
    method: 'POST',
    headers: { origin: values.APP_URL!, 'content-type': 'application/json' },
    body: ' '.repeat(17_000) + JSON.stringify({ username: adminUsername, password }),
  })
  assert.equal((await route(large, ['auth', 'login'])).status, 413)
  const bad = new Request(values.APP_URL + '/api/auth/login', {
    method: 'POST',
    headers: { origin: values.APP_URL!, 'content-type': 'application/json' },
    body: '{broken',
  })
  assert.equal((await route(bad, ['auth', 'login'])).status, 400)
  assert.equal(
    (await call('auth/login', { username: adminUsername, password }, '', { 'content-type': 'text/plain' })).status,
    415,
  )
})

test('HTTP methods, paths and browser-provided auth objects cannot bypass the facade', async () => {
  assert.equal((await route(new Request(values.APP_URL + '/api/auth/login'), ['auth', 'login'])).status, 405)
  assert.equal((await route(request('auth/login', {}), ['auth/login'])).status, 404)
  const response = await call(
    'crm',
    { action: 'getUsers', payload: {}, auth: { id: adminId, role: 'admin' } },
    adminCookie,
  )
  assert.equal(response.status, 400)
})

test('database rate counters are atomic and expired buckets reset with a new guaranteed TTL', async () => {
  const key = randomBytes(32).toString('hex')
  const counts = await Promise.all(Array.from({ length: 12 }, () => incrementAuthBucket(db, key)))
  assert.deepEqual(
    counts.sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, index) => index + 1),
  )
  await db.authRateBucket.update({ where: { key }, data: { expiresAt: new Date(0) } })
  assert.equal(await incrementAuthBucket(db, key), 1)
  assert.ok((await db.authRateBucket.findUniqueOrThrow({ where: { key } })).expiresAt > new Date())
})

test('spoofed forwarding headers do not reset login quotas', async () => {
  for (let index = 0; index < 8; index++) {
    const response = await call('auth/login', { username: 'missing-throttle', password }, '', {
      'x-forwarded-for': '192.0.2.' + index,
      'x-lotos-client-ip': '192.0.2.' + index,
    })
    assert.equal(response.status, 401)
  }
  const response = await call('auth/login', { username: 'missing-throttle', password }, '', {
    'x-forwarded-for': '198.51.100.10',
  })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '900')
  assert.equal(trustedClientIp(new Headers({ 'x-forwarded-for': '198.51.100.10' }), values), 'unknown')
  assert.equal(
    trustedClientIp(new Headers({ 'x-lotos-client-ip': '198.51.100.10' }), { ...values, TRUSTED_PROXY: 'caddy' }),
    '198.51.100.10',
  )
  assert.equal(
    trustedClientIp(new Headers({ 'x-lotos-client-ip': 'not-an-ip' }), { ...values, TRUSTED_PROXY: 'caddy' }),
    'unknown',
  )
})

test('linking accounts requires an exact branch and unique profile identity', async () => {
  const fixture = await coachFixture()
  const card = await db.coach.create({ data: { name: 'Unlinked test coach', branchId: branch } })
  const input = { userId: fixture.user.id, coachId: card.id, requestId: randomUUID() }
  assert.equal((await crm('linkCoachUser', input)).status, 200)
  assert.equal((await db.coach.findUniqueOrThrow({ where: { id: card.id } })).userId, fixture.user.id)
  const other = await coachFixture()
  assert.equal((await crm('linkCoachUser', { ...input, userId: other.user.id, requestId: randomUUID() })).status, 409)
  const wrong = await db.coach.create({ data: { name: 'Other branch test coach', branchId: otherBranch } })
  assert.equal(
    (await crm('linkCoachUser', { userId: other.user.id, coachId: wrong.id, requestId: randomUUID() })).status,
    403,
  )
})

test('permissions and public identity contain no permission snapshot from the browser', async () => {
  const fixture = await coachFixture()
  const logged = await signIn(fixture.username)
  const actor = await requireActor(db, auth, new Headers({ cookie: logged.cookie }))
  assert.deepEqual(Object.keys(apiUser(actor)).sort(), ['branchId', 'id', 'role', 'username'])
  assert.throws(() => authorizeAction('deleteLesson', actor))
  authorizeAction('createLesson', actor)
})

test('legacy GAS hashes are not silently accepted or rewritten by login', async () => {
  const fixture = await coachFixture()
  const legacy = await legacyHashPassword(password)
  await db.account.updateMany({ where: { userId: fixture.user.id }, data: { password: legacy } })
  const response = await call('auth/login', { username: fixture.username, password })
  assert.equal(response.status, 401)
  assert.equal(await db.session.count({ where: { userId: fixture.user.id } }), 0)
  assert.equal((await db.account.findFirstOrThrow({ where: { userId: fixture.user.id } })).password, legacy)
  const replacement = randomBytes(24).toString('hex')
  assert.equal(
    (await crm('resetCoachPassword', { userId: fixture.user.id, newPassword: replacement, requestId: randomUUID() }))
      .status,
    200,
  )
  await signIn(fixture.username, replacement)
})

test('database/session-service errors fail closed without exposing connection or password details', async () => {
  const failing = new Proxy(auth, {
    get(target, key) {
      if (key !== 'api') return Reflect.get(target, key)
      return new Proxy(target.api, {
        get(api, name) {
          if (name !== 'getSession') return Reflect.get(api, name)
          return new Proxy(api.getSession, {
            apply() {
              throw new Error('PRIVATE-CONNECTION-AND-PASSWORD')
            },
          })
        },
      })
    },
  })
  const guarded = createPostgresRouter(db, failing, values)
  const response = await guarded(request('auth/session', undefined, adminCookie), ['auth', 'session'])
  assert.equal(response.status, 503)
  assert.equal((await response.text()).includes('PRIVATE-CONNECTION-AND-PASSWORD'), false)
})
