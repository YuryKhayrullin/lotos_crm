import assert from 'node:assert/strict'
import { before, after, beforeEach, test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { validateEnvironment } from '../../scripts/lib/environment.mjs'
import { createPostgresClient } from '../../lib/server/postgres/client'
import { createPostgresAuth } from '../../lib/server/postgres/auth'
import { createPostgresRouter } from '../../lib/server/postgres/http'
import { hashPassword } from 'better-auth/crypto'

validateEnvironment(process.env, 'test')
const db = createPostgresClient(process.env),
  auth = createPostgresAuth(db, process.env)
const route = createPostgresRouter(db, auth, process.env),
  password = randomBytes(24).toString('hex')
let cookie = '',
  branch = '',
  otherBranch = '',
  coachCookie = '',
  coachId = ''
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
async function call(path: string, body: unknown, identity = cookie) {
  return route(
    new Request(process.env.APP_URL + '/api/' + path, {
      method: 'POST',
      headers: { origin: process.env.APP_URL!, 'content-type': 'application/json', cookie: identity },
      body: JSON.stringify(body),
    }),
    path.split('/'),
  )
}
const crm = (action: string, payload: unknown, identity = cookie) => call('crm', { action, payload }, identity)
async function success(action: string, payload: unknown) {
  const response = await crm(action, payload)
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  return response.json()
}
const clientInput = (extra = {}) => ({
  requestId: randomUUID(),
  branchId: branch,
  childName: 'Тестовый ребёнок',
  parentName: 'Вымышленный родитель',
  phone: '+79990000000',
  email: 'fictional@example.invalid',
  birthDate: '01.03.2015',
  category: 'плавание',
  lessonsPerWeek: 1,
  ...extra,
})
before(async () => {
  // Explicit fixture in a guarded disposable DB, not a production bootstrap.
  const user = await db.user.create({
    data: { username: 'domain-admin', name: 'Fictional admin', role: 'admin', status: 'active' },
  })
  await db.account.create({
    data: { userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) },
  })
  cookie = cookies(await call('auth/login', { username: 'domain-admin', password }, ''))
  branch = (await success('createBranch', { requestId: randomUUID(), name: 'Fictional A', address: 'Test' })).id
  otherBranch = (await success('createBranch', { requestId: randomUUID(), name: 'Fictional B', address: 'Test' })).id
  const coach = await success('createCoach', {
    requestId: randomUUID(),
    name: 'Fictional Coach',
    branchId: branch,
    username: 'domain-coach',
    password,
  })
  coachId = coach.id
  coachCookie = cookies(await call('auth/login', { username: 'domain-coach', password }, ''))
})
beforeEach(async () => {
  await db.authRateBucket.deleteMany()
})
after(async () => {
  await db.$disconnect()
})

test('branch creation is durable and conflicting repeats cannot create another branch', async () => {
  const input = { requestId: randomUUID(), name: 'One durable pool', address: 'Test' }
  const first = await success('createBranch', input),
    second = await success('createBranch', input)
  assert.equal(first.id, second.id)
  assert.equal((await crm('createBranch', { ...input, name: 'Changed' })).status, 409)
})
test('durable inbox recovers a SQL-failed client with original initial payment and no duplicate after reload', async () => {
  const input = clientInput({ paidAmount: 5500 }),
    before = await db.client.count()
  await db.$executeRawUnsafe(
    "CREATE FUNCTION test_draft_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='createClient' THEN RAISE EXCEPTION 'fictional failure'; END IF; RETURN NEW; END $$",
  )
  await db.$executeRawUnsafe(
    'CREATE TRIGGER test_draft_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_draft_failure()',
  )
  try {
    assert.equal((await crm('createClient', input)).status, 503)
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER test_draft_failure ON audit_events')
    await db.$executeRawUnsafe('DROP FUNCTION test_draft_failure()')
  }
  assert.equal(await db.client.count(), before)
  const inbox = await route(new Request(process.env.APP_URL + '/api/mutation-drafts', { headers: { cookie } }), [
    'mutation-drafts',
  ])
  const metadata = (await inbox.json()).items.find((row: { requestId: string }) => row.requestId === input.requestId)
  assert.equal(metadata.confirmed, false)
  assert.equal(JSON.stringify(metadata).includes(input.childName), false)
  assert.equal(
    (await call('mutation-drafts', { requestId: input.requestId, mode: 'recover' }, coachCookie)).status,
    404,
  )
  const first = await call('mutation-drafts', { requestId: input.requestId, mode: 'recover' })
  assert.equal(first.status, 200)
  assert.equal((await first.json()).confirmed, true)
  assert.equal((await call('mutation-drafts', { requestId: input.requestId, mode: 'recover' })).status, 200)
  assert.equal(await db.client.count(), before + 1)
  const draft = await db.mutationDraft.findFirstOrThrow({ where: { requestKey: input.requestId } })
  assert.equal(draft.state, 'acknowledged')
  assert.deepEqual(draft.payload, {})
  const audit = await db.auditEvent.findFirstOrThrow({
    where: {
      requestId: (await db.mutationRequest.findFirstOrThrow({ where: { requestKey: input.requestId } })).id,
      action: 'createClient',
    },
  })
  assert.equal(await db.payment.count({ where: { clientId: audit.entityId } }), 1)
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: audit.entityId } })).remainingLessons, 4)
})
test('explicit close prevents a previously prepared mutation from writing and cannot undo a confirmed one', async () => {
  const input = clientInput({ paidAmount: 1 })
  assert.equal((await crm('createClient', input)).status, 422)
  assert.equal((await call('mutation-drafts', { requestId: input.requestId, mode: 'acknowledge' })).status, 409)
  const closed = await call('mutation-drafts', { requestId: input.requestId, mode: 'close' })
  assert.equal((await closed.json()).confirmed, false)
  assert.equal((await crm('createClient', input)).status, 409)
  assert.equal((await call('mutation-drafts', { requestId: input.requestId, mode: 'recover' })).status, 409)
  const valid = clientInput(),
    client = await success('createClient', valid)
  const result = await call('mutation-drafts', { requestId: valid.requestId, mode: 'close' })
  assert.equal((await result.json()).confirmed, true)
  assert.ok(await db.client.findUnique({ where: { id: client.id } }))
  assert.equal((await crm('createClient', { ...valid, childName: 'Different' })).status, 409)
})
test('mutation recovery cannot expose or resolve another administrator’s private payload', async () => {
  const data = clientInput(),
    client = await success('createClient', data)
  const user = await db.user.create({
    data: { username: 'isolated-recovery-admin', name: 'Fictional', role: 'admin', status: 'active' },
  })
  await db.account.create({
    data: { userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) },
  })
  const other = cookies(await call('auth/login', { username: user.username, password }, ''))
  const inbox = await route(new Request(process.env.APP_URL + '/api/mutation-drafts', { headers: { cookie: other } }), [
    'mutation-drafts',
  ])
  assert.deepEqual((await inbox.json()).items, [])
  for (const mode of ['recover', 'acknowledge', 'close'])
    assert.equal((await call('mutation-drafts', { requestId: data.requestId, mode }, other)).status, 404)
  assert.equal(
    (await call('mutation-drafts', { requestId: data.requestId, mode: 'recover', payload: { paidAmount: 5500 } }))
      .status,
    400,
  )
  assert.ok(await db.client.findUnique({ where: { id: client.id } }))
})
test('client creation ignores no accounting fields; unpaid card has exactly zero credits', async () => {
  const input = clientInput(),
    client = await success('createClient', input)
  assert.equal(client.remainingLessons, 0)
  assert.equal(client.totalLessons, 0)
  assert.equal(client.paidAmount, 0)
  assert.equal(client.birthDate, input.birthDate)
  assert.equal(client.version, 1)
  assert.equal((await success('createClient', input)).id, client.id)
})
test('insufficient initial payment is rejected without losing money or creating a card', async () => {
  const input = clientInput({ paidAmount: 5499 }),
    before = await db.client.count()
  const response = await crm('createClient', input)
  assert.equal(response.status, 422)
  assert.match((await response.json()).message, /полного абонемента/)
  assert.equal(await db.client.count(), before)
  assert.equal(await db.mutationRequest.count({ where: { requestKey: input.requestId } }), 0)
})
test('virtual subscriptions, explicit balances, assignments and service fields are rejected', async () => {
  for (const extra of [
    { subscription: { remainingLessons: 4 } },
    { remainingLessons: 4 },
    { paidAmountMinor: '10' },
    { assignedLessonIds: ['forged'] },
    { id: 'forged' },
    { ledgerVersion: 9 },
  ])
    assert.equal((await crm('createClient', clientInput(extra))).status, 400)
})
test('client update requires a version and strictly forbids branch/ledger/enrollment changes', async () => {
  const client = await success('createClient', clientInput())
  for (const extra of [
    {},
    { branchId: otherBranch },
    { remainingLessons: 10 },
    { paidAmount: 0 },
    { assignedLessonIds: [] },
  ]) {
    const payload = {
      id: client.id,
      requestId: randomUUID(),
      childName: 'New name',
      ...(Object.keys(extra).length ? { expectedVersion: 1, ...extra } : {}),
    }
    assert.equal((await crm('updateClient', payload)).status, 400)
  }
  const update = { id: client.id, expectedVersion: 1, requestId: randomUUID(), childName: 'Changed name' }
  await success('updateClient', update)
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: client.id } })).version, 2)
  assert.equal((await crm('updateClient', { ...update, requestId: randomUUID() })).status, 409)
  await success('updateClient', {
    id: client.id,
    expectedVersion: 2,
    requestId: randomUUID(),
    childName: 'More recent',
  })
  await success('updateClient', update)
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: client.id } })).childName, 'More recent')
})
test('concurrent duplicate client creation has one card, audit and confirmation', async () => {
  const input = clientInput()
  const results = await Promise.all([crm('createClient', input), crm('createClient', input)])
  assert.ok(results.every((result) => result.status === 200))
  assert.equal((await results[0].json()).id, (await results[1].json()).id)
  assert.equal(await db.mutationRequest.count({ where: { requestKey: input.requestId } }), 1)
})

test('partial archival never resets unsubmitted category or frequency to creation defaults', async () => {
  const client = await success('createClient', clientInput({ category: 'синхронное плавание', lessonsPerWeek: 3 }))
  await success('updateClient', { id: client.id, requestId: randomUUID(), expectedVersion: 1, status: 'Архив' })
  const current = await db.client.findUniqueOrThrow({ where: { id: client.id } })
  assert.equal(current.category, 'synchronized_swimming')
  assert.equal(current.lessonsPerWeek, 3)
})
test('deletion of a genuinely empty client is durable and creation replay never resurrects it', async () => {
  const input = clientInput(),
    client = await success('createClient', input)
  const deletion = { id: client.id, expectedVersion: 1, requestId: randomUUID() }
  await success('deleteClient', deletion)
  await success('deleteClient', deletion)
  assert.equal(await db.client.findUnique({ where: { id: client.id } }), null)
  assert.equal((await crm('createClient', input)).status, 409)
})
test('balances prohibit deletion and archival keeps the card and historical links', async () => {
  const client = await success('createClient', clientInput())
  await db.client.update({ where: { id: client.id }, data: { totalLessons: 1, remainingLessons: 1 } }) // deliberate test corruption, never seed production
  assert.equal((await crm('deleteClient', { id: client.id, expectedVersion: 1, requestId: randomUUID() })).status, 409)
  await success('updateClient', { id: client.id, expectedVersion: 1, requestId: randomUUID(), status: 'Архив' })
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: client.id } })).totalLessons, 1)
})
test('pagination, Russian search, status and financial sorting operate on the full scoped dataset', async () => {
  await success('createClient', clientInput({ childName: 'Уникальный ученик', parentName: 'Unique parent' }))
  await success('createClient', clientInput({ branchId: otherBranch, childName: 'Уникальный чужой' }))
  const page = await success('getClients', {
    branchId: branch,
    query: 'уникальный',
    page: 1,
    pageSize: 1,
    sortBy: 'paidAmount',
    sortDir: 'desc',
  })
  assert.equal(page.total, 1)
  assert.equal(page.items.length, 1)
  assert.equal(page.hasMore, false)
  assert.equal(page.items[0].childName, 'Уникальный ученик')
})
test('all coach reads enforce canonical branch and omit personal/financial data, including search side channels', async () => {
  for (const [action, payload] of [
    ['getClients', { branchId: otherBranch }],
    ['getSheet', { sheet: 'Клиенты', branchId: otherBranch }],
    ['searchClientOptions', { branchId: otherBranch, limit: 500 }],
  ] as const) {
    const response = await crm(action, payload, coachCookie)
    assert.equal(response.status, 200)
    const body = await response.json(),
      rows = Array.isArray(body) ? body : body.items
    assert.ok(rows.length > 0)
    for (const row of rows) {
      assert.equal(row.branchId, branch)
      for (const field of [
        'phone',
        'email',
        'parentName',
        'birthDate',
        'paidAmount',
        'paymentBalance',
        'receiptUrl',
        'totalLessons',
        'comment',
        'purchasedAt',
      ])
        assert.equal(field in row, false, field)
    }
  }
  assert.equal((await crm('getClients', { sortBy: 'paidAmount' }, coachCookie)).status, 403)
  assert.equal((await (await crm('getClients', { query: 'fictional@example.invalid' }, coachCookie)).json()).total, 0)
})
test('coach cannot mutate catalog via a direct API, even with valid IDs', async () => {
  for (const action of ['createBranch', 'createClient', 'updateClient', 'deleteClient', 'createCoach', 'deleteCoach'])
    assert.equal((await crm(action, { id: coachId, requestId: randomUUID() }, coachCookie)).status, 403)
})
test('coach with or without credentials is persisted; duplicate login rolls back the whole creation', async () => {
  const input = { requestId: randomUUID(), name: 'Second fictional coach', branchId: branch, phone: '+79990000000' }
  const coach = await success('createCoach', input)
  assert.equal(coach.userId, '')
  assert.equal((await success('createCoach', input)).id, coach.id)
  const before = await db.coach.count(),
    key = randomUUID()
  assert.equal((await crm('createCoach', { ...input, requestId: key, username: 'domain-coach', password })).status, 409)
  assert.equal(await db.coach.count(), before)
  assert.equal(await db.mutationRequest.count({ where: { requestKey: key } }), 0)
})
test('audit failure rolls back a domain write and its durable marker', async () => {
  await db.$executeRawUnsafe(
    "CREATE FUNCTION test_catalog_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'createClient' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$",
  )
  await db.$executeRawUnsafe(
    'CREATE TRIGGER test_catalog_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_catalog_audit_failure()',
  )
  const before = await db.client.count(),
    input = clientInput()
  try {
    assert.equal((await crm('createClient', input)).status, 503)
    assert.equal(await db.client.count(), before)
    assert.equal(await db.mutationRequest.count({ where: { requestKey: input.requestId } }), 0)
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER test_catalog_audit_failure ON audit_events')
    await db.$executeRawUnsafe('DROP FUNCTION test_catalog_audit_failure()')
  }
})

test('concurrent coach creation and rejected admin-target account mutation have a consistent lock order', async () => {
  const admin = await db.user.findUniqueOrThrow({ where: { username: 'domain-admin' } })
  const input = { name: 'Concurrent fictional coach', branchId: branch, requestId: randomUUID() }
  const [first, duplicate, rejected] = await Promise.all([
    crm('createCoach', input),
    crm('createCoach', input),
    crm('resetCoachPassword', { userId: admin.id, newPassword: password, requestId: randomUUID() }),
  ])
  assert.equal(first.status, 200)
  assert.equal(duplicate.status, 200)
  assert.equal(rejected.status, 403)
  assert.equal((await first.json()).id, (await duplicate.json()).id)
  assert.equal(await db.coach.count({ where: { name: input.name } }), 1)
})
test('history uses actual journal rows and reports corrupted balances rather than inventing payments', async () => {
  const client = await success('createClient', clientInput())
  assert.deepEqual(
    (await success('getClientHistory', { clientId: client.id, includeAudit: true })).audit.discrepancies,
    [],
  )
  await db.client.update({ where: { id: client.id }, data: { remainingLessons: 1, totalLessons: 1 } })
  const history = await success('getClientHistory', { clientId: client.id, includeAudit: true })
  assert.equal(history.payments.length, 0)
  assert.equal(history.audit.discrepancies.length, 1)
  assert.equal((await crm('getClientHistory', { clientId: client.id }, coachCookie)).status, 403)
})
test('archived coach keeps stable identity but cannot be reactivated through account controls', async () => {
  const creation = {
    name: 'Archived fictional coach',
    branchId: branch,
    requestId: randomUUID(),
    username: 'archived-domain-coach',
    password,
  }
  const profile = await success('createCoach', creation)
  await success('deleteCoach', { id: profile.id, requestId: randomUUID() })
  assert.ok((await db.coach.findUniqueOrThrow({ where: { id: profile.id } })).archivedAt)
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: profile.userId } })).status, 'disabled')
  assert.equal((await crm('activateUser', { userId: profile.userId, requestId: randomUUID() })).status, 409)
  assert.equal((await crm('createCoach', creation)).status, 409)
  const accounts = await success('getUsers', {})
  assert.equal(accounts.find((user: { id: string }) => user.id === profile.userId).profileArchived, true)
})
