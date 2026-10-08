import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { validateEnvironment } from '../../scripts/lib/environment.mjs'
import { createPostgresClient } from '../../lib/server/postgres/client'
import { createPostgresAuth } from '../../lib/server/postgres/auth'
import { createPostgresRouter } from '../../lib/server/postgres/http'

validateEnvironment(process.env, 'test')
const db = createPostgresClient(process.env),
  route = createPostgresRouter(db, createPostgresAuth(db, process.env), process.env)
const password = randomBytes(24).toString('hex')
let admin = '',
  branch = ''
async function call(path: string, body: unknown, cookie = admin) {
  return route(
    new Request(process.env.APP_URL + '/api/' + path, {
      method: 'POST',
      headers: { origin: process.env.APP_URL!, 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
    path.split('/'),
  )
}
const crm = (action: string, payload: unknown) => call('crm', { action, payload })
async function ok(action: string, payload: unknown) {
  const response = await crm(action, payload)
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  return response.json()
}
const input = (extra = {}) => ({
  requestId: randomUUID(),
  branchId: branch,
  childName: 'Accounting fictional pupil',
  parentName: 'Test parent',
  ...extra,
})
before(async () => {
  const user = await db.user.create({
    data: { username: 'accounting-admin', name: 'Fictional accounting admin', role: 'admin', status: 'active' },
  })
  await db.account.create({
    data: { userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) },
  })
  const response = await call('auth/login', { username: user.username, password }, '')
  assert.equal(response.status, 200)
  admin = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  branch = (await ok('createBranch', { requestId: randomUUID(), name: 'Accounting test pool', address: 'Fictional' }))
    .id
})
after(async () => {
  await db.$disconnect()
})
test('initial payment creates exactly one card, payment and ledger movement in the same transaction', async () => {
  const data = input({ paidAmount: 5500.01 }),
    first = await ok('createClient', data),
    duplicate = await ok('createClient', data)
  assert.equal(first.id, duplicate.id)
  assert.equal(first.remainingLessons, 4)
  assert.equal(first.paymentBalance, 0.01)
  const row = await db.client.findUniqueOrThrow({ where: { id: first.id } })
  assert.equal(row.paidAmountMinor, BigInt(550001))
  assert.equal(row.paymentBalanceMinor, BigInt(1))
  assert.equal(await db.payment.count({ where: { clientId: first.id } }), 1)
  assert.equal(await db.lessonLedgerEntry.count({ where: { clientId: first.id } }), 1)
  assert.equal((await ok('auditLessonLedger', { clientId: first.id })).discrepancies.length, 0)
})
test('tariff and carry use integer kopecks; later retry returns current balances, not an old snapshot', async () => {
  const card = await ok('createClient', input({ paidAmount: 5500.01 }))
  const payment = { requestId: randomUUID(), clientId: card.id, amount: 5499.99 }
  const first = await ok('recordPayment', payment)
  assert.equal(first.client.remainingLessons, 8)
  assert.equal(first.client.paymentBalance, 0)
  await ok('recordAdjustment', {
    requestId: randomUUID(),
    clientId: card.id,
    lessonsDelta: -1,
    reason: 'Explicit test correction',
  })
  const replay = await ok('recordPayment', payment)
  assert.equal(replay.payment.id, first.payment.id)
  assert.equal(replay.duplicate, true)
  assert.equal(replay.client.remainingLessons, 7)
  assert.equal((await crm('recordPayment', { ...payment, amount: 5500 })).status, 409)
})
test('concurrent duplicate payments do not double-credit; distinct payments are serialized per client', async () => {
  const card = await ok('createClient', input()),
    payment = { requestId: randomUUID(), clientId: card.id, amount: 5500 }
  const duplicate = await Promise.all([crm('recordPayment', payment), crm('recordPayment', payment)])
  assert.ok(duplicate.every((value) => value.status === 200))
  const separate = await Promise.all([
    crm('recordPayment', { ...payment, requestId: randomUUID() }),
    crm('recordPayment', { ...payment, requestId: randomUUID() }),
  ])
  assert.ok(separate.every((value) => value.status === 200))
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: card.id } })).remainingLessons, 12)
  assert.equal(await db.payment.count({ where: { clientId: card.id } }), 3)
})
test('invalid amounts and insufficient packets never create partial accounting rows', async () => {
  const card = await ok('createClient', input())
  for (const amount of [0, -1, 1.001, 1, 5499]) {
    const response = await crm('recordPayment', { requestId: randomUUID(), clientId: card.id, amount })
    assert.ok([400, 422].includes(response.status))
  }
  assert.equal(await db.payment.count({ where: { clientId: card.id } }), 0)
  const key = input({ paidAmount: 1 })
  assert.equal((await crm('createClient', key)).status, 422)
  assert.equal(await db.mutationRequest.count({ where: { requestKey: key.requestId } }), 0)
})
test('adjustments preserve manual paused/archived status, require reason, and cannot underflow', async () => {
  const card = await ok('createClient', input({ status: 'Пауза', paidAmount: 5500 }))
  const adjust = { requestId: randomUUID(), clientId: card.id, lessonsDelta: -1, reason: 'Explicit correction' }
  await ok('recordAdjustment', adjust)
  await ok('recordAdjustment', adjust)
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: card.id } })).remainingLessons, 3)
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: card.id } })).status, 'paused')
  assert.equal((await crm('recordAdjustment', { ...adjust, requestId: randomUUID(), reason: '' })).status, 400)
  assert.equal((await crm('recordAdjustment', { ...adjust, requestId: randomUUID(), lessonsDelta: -100 })).status, 400)
})
test('confirmed repair retains GAS card-authoritative credits with a complete stale-audit fingerprint', async () => {
  const card = await ok('createClient', input({ paidAmount: 5500.01 }))
  await ok('recordPayment', { requestId: randomUUID(), clientId: card.id, amount: 5499.99 })
  await db.client.update({ where: { id: card.id }, data: { remainingLessons: 10, totalLessons: 10 } }) // explicit isolated corruption fixture
  const audit = (await ok('auditLessonLedger', { clientId: card.id })).discrepancies[0]
  const historyAudit = (await ok('getClientHistory', { clientId: card.id, includeAudit: true })).audit.discrepancies[0]
  assert.equal(historyAudit.auditFingerprint, audit.auditFingerprint, 'display order must not change the audit token')
  assert.equal(audit.repairable, true)
  const repair = {
    requestId: randomUUID(),
    clientId: card.id,
    confirmed: true,
    reason: 'Confirmed fictional legacy balance',
    expectedRemainingLessons: 10,
    expectedTotalLessons: 10,
    auditFingerprint: historyAudit.auditFingerprint,
  }
  // A rejected stale audit is a different attempt, not permission to change
  // the frozen payload of the subsequently confirmed request.
  assert.equal(
    (await crm('repairLessonLedger', { ...repair, requestId: randomUUID(), auditFingerprint: '0'.repeat(64) })).status,
    409,
  )
  await ok('repairLessonLedger', repair)
  await ok('repairLessonLedger', repair)
  assert.equal((await ok('auditLessonLedger', { clientId: card.id })).discrepancies.length, 0)
  assert.equal(await db.lessonLedgerEntry.count({ where: { clientId: card.id } }), 3)
})
test('monetary corruption is diagnosed and never repaired by inventing a payment', async () => {
  const card = await ok('createClient', input({ paidAmount: 5500 }))
  await db.client.update({ where: { id: card.id }, data: { paidAmountMinor: BigInt(1) } })
  const audit = (await ok('auditLessonLedger', { clientId: card.id })).discrepancies[0]
  assert.equal(audit.repairable, false)
  assert.ok(audit.paymentIssues.length)
  assert.equal((await crm('recordPayment', { requestId: randomUUID(), clientId: card.id, amount: 5500 })).status, 409)
})
test('missing confirmed payment is restored with one link and no duplicate monetary credit', async () => {
  const card = await ok('createClient', input())
  const user = await db.user.findUniqueOrThrow({ where: { username: 'accounting-admin' } })
  const marker = await db.mutationRequest.create({
    data: { actorId: user.id, requestKey: randomUUID(), action: 'fixture', fingerprint: 'b'.repeat(64), result: {} },
  })
  const payment = await db.payment.create({
    data: {
      clientId: card.id,
      branchId: branch,
      actorId: user.id,
      requestId: marker.id,
      amountMinor: BigInt(550000),
      category: 'swimming',
      lessonsPerWeek: 1,
      packagePriceMinor: BigInt(550000),
      packageLessons: 4,
      packagesCount: 1,
      lessonsAdded: 4,
      paidAt: new Date(),
    },
  })
  await db.client.update({
    where: { id: card.id },
    data: { remainingLessons: 4, totalLessons: 4, paidAmountMinor: BigInt(550000) },
  })
  const audit = (await ok('auditLessonLedger', { clientId: card.id })).discrepancies[0]
  assert.deepEqual(audit.missingPaymentIds, [payment.id])
  assert.equal(audit.repairable, true)
  await ok('repairLessonLedger', {
    clientId: card.id,
    requestId: randomUUID(),
    expectedRemainingLessons: 4,
    expectedTotalLessons: 4,
    confirmed: true,
    reason: 'Restore confirmed fixture',
    auditFingerprint: audit.auditFingerprint,
  })
  assert.equal((await ok('auditLessonLedger', { clientId: card.id })).discrepancies.length, 0)
  assert.equal(await db.payment.count({ where: { clientId: card.id } }), 1)
  assert.equal(await db.lessonLedgerEntry.count({ where: { paymentId: payment.id } }), 1)
})
test('finance and subscriptions read actual scoped card totals, including archived clients', async () => {
  const isolated = (
    await ok('createBranch', { requestId: randomUUID(), name: 'Finance test scope', address: 'Fictional' })
  ).id
  await ok('createClient', input({ branchId: isolated, status: 'Архив', paidAmount: 5500 }))
  const result = await ok('getFinanceSummary', { branchId: isolated })
  assert.equal(result.totalPaidAmount, 5500)
  assert.equal(result.remainingLessons, 4)
  assert.equal(result.archivedClients, 1)
  assert.equal((await ok('getSubscriptionsPage', { branchId: isolated })).items.length, 1)
  assert.equal((await crm('auditLessonLedger', { clientId: randomUUID() })).status, 404)
})
test('audit failure rolls back both initial payment creation and subsequent credits', async () => {
  const card = await ok('createClient', input())
  await db.$executeRawUnsafe(
    "CREATE FUNCTION test_finance_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('createClient','recordPayment') THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$",
  )
  await db.$executeRawUnsafe(
    'CREATE TRIGGER test_finance_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_finance_audit_failure()',
  )
  try {
    const creation = input({ paidAmount: 5500 }),
      payment = { requestId: randomUUID(), clientId: card.id, amount: 5500 }
    const before = await db.client.count()
    assert.equal((await crm('createClient', creation)).status, 503)
    assert.equal(await db.client.count(), before)
    assert.equal((await crm('recordPayment', payment)).status, 503)
    assert.equal(await db.payment.count({ where: { clientId: card.id } }), 0)
    assert.equal(await db.mutationRequest.count({ where: { requestKey: payment.requestId } }), 0)
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER test_finance_audit_failure ON audit_events')
    await db.$executeRawUnsafe('DROP FUNCTION test_finance_audit_failure()')
  }
})
