import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { createPostgresClient } from '../../lib/server/postgres/client'
import { createPostgresAuth } from '../../lib/server/postgres/auth'
import { createPostgresRouter } from '../../lib/server/postgres/http'
import { recoverableActions } from '../../lib/server/postgres/mutations'
import { validateEnvironment } from '../../scripts/lib/environment.mjs'

validateEnvironment(process.env, 'test')
const db = createPostgresClient(process.env),
  auth = createPostgresAuth(db, process.env)
const route = createPostgresRouter(db, auth, process.env)
const password = randomBytes(24).toString('hex')
let cookie = '',
  branch = '',
  otherBranch = '',
  adminId = '',
  hash = ''
function request(path: string, body: unknown, identity = cookie) {
  return new Request(process.env.APP_URL + '/api/' + path, {
    method: 'POST',
    headers: { origin: process.env.APP_URL!, 'content-type': 'application/json', cookie: identity },
    body: JSON.stringify(body),
  })
}
const call = (path: string, body: unknown, identity = cookie) => route(request(path, body, identity), path.split('/'))
const crm = (action: string, payload: unknown) => call('crm', { action, payload })
before(async () => {
  hash = await hashPassword(password)
  const admin = await db.user.create({
    data: { username: 'recovery-matrix-admin', name: 'Fictional', role: 'admin', status: 'active' },
  })
  adminId = admin.id
  await db.account.create({ data: { userId: admin.id, accountId: admin.id, providerId: 'credential', password: hash } })
  const response = await call('auth/login', { username: admin.username, password }, '')
  assert.equal(response.status, 200)
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  branch = (await db.branch.create({ data: { name: 'Fictional recovery pool', address: 'Test' } })).id
  otherBranch = (await db.branch.create({ data: { name: 'Fictional destination', address: 'Test' } })).id
})
after(async () => {
  await db.$disconnect()
})

async function fixture(action: string) {
  const key = randomUUID()
  const user = await db.user.create({
    data: {
      username: 'matrix-' + key.slice(0, 8),
      name: 'Fictional',
      status: action === 'activateUser' ? 'disabled' : 'active',
      branchId: branch,
    },
  })
  await db.account.create({ data: { userId: user.id, accountId: user.id, providerId: 'credential', password: hash } })
  const coach = await db.coach.create({
    data: {
      name: 'Fictional',
      branchId: branch,
      userId: action === 'linkCoachUser' ? null : user.id,
      memberships: { create: { branchId: branch } },
    },
  })
  const client = await db.client.create({
    data: { childName: 'Fictional pupil', parentName: 'Fictional parent', branchId: branch },
  })
  const date = '2090-01-03'
  const lesson = await db.lesson.create({
    data: {
      branchId: branch,
      coachId: coach.id,
      createdById: adminId,
      title: 'Fictional future lesson',
      category: 'swimming',
      localDate: new Date(date),
      timeZone: 'Europe/Moscow',
      startsAt: new Date(date + 'T14:00:00Z'),
      endsAt: new Date(date + 'T15:00:00Z'),
      rosterConfirmed: true,
    },
  })
  const inputs: Record<string, Record<string, unknown>> = {
    createClient: { branchId: branch, childName: 'Fictional ' + key, parentName: 'Fictional', paidAmount: 5500 },
    createBranch: { name: 'Fictional ' + key, address: 'Test' },
    createCoach: { branchId: branch, name: 'Fictional ' + key, username: 'new-' + key.slice(0, 8), password },
    updateClient: { id: client.id, expectedVersion: 1, parentName: 'Changed fictional parent' },
    deleteClient: { id: client.id, expectedVersion: 1 },
    deleteCoach: { id: coach.id },
    createLesson: {
      branchId: branch,
      coachId: coach.id,
      date,
      time: '17:00',
      title: 'Fictional',
      category: 'плавание',
      clientIds: [],
    },
    createLessonWithClients: {
      branchId: branch,
      coachId: coach.id,
      date,
      time: '17:00',
      title: 'Fictional',
      category: 'плавание',
      clientIds: [client.id],
    },
    updateLesson: { id: lesson.id, expectedVersion: 1, pool: 'Changed fictional pool' },
    cancelLesson: { id: lesson.id, expectedVersion: 1, reason: 'Fictional cancellation' },
    deleteLesson: { id: lesson.id, expectedVersion: 1 },
    assignClientLesson: { clientId: client.id, lessonId: lesson.id, expectedVersion: 1 },
    recordPayment: { clientId: client.id, amount: 5500 },
    recordAdjustment: { clientId: client.id, lessonsDelta: 1, reason: 'Fictional adjustment' },
    assignUserBranch: { userId: user.id, branchId: otherBranch },
    deactivateUser: { userId: user.id },
    activateUser: { userId: user.id },
    resetCoachPassword: { userId: user.id, newPassword: password },
    revokeUserSessions: { userId: user.id },
    linkCoachUser: { userId: user.id, coachId: coach.id },
  }
  if (action === 'repairLessonLedger') {
    await db.client.update({ where: { id: client.id }, data: { remainingLessons: 1, totalLessons: 1 } })
    const audit = await crm('auditLessonLedger', { clientId: client.id })
    assert.equal(audit.status, 200)
    const item = (await audit.json()).discrepancies[0]
    inputs[action] = {
      clientId: client.id,
      reason: 'Fictional audit repair',
      confirmed: true,
      expectedRemainingLessons: 1,
      expectedTotalLessons: 1,
      auditFingerprint: item.auditFingerprint,
    }
  }
  return { payload: { ...inputs[action], requestId: key }, user, client, lesson }
}

// Every recoverable CRM mutation gets the same fault/reload/privacy/close contract.
// Files and attendance have their own transactional recovery suites.
for (const action of recoverableActions)
  test('recovery matrix: ' + action, async () => {
    const first = await fixture(action)
    const invalid = await crm(action, { ...first.payload, unknownField: true })
    assert.equal(invalid.status, 400)
    assert.equal(await db.mutationDraft.count({ where: { actorId: adminId, requestKey: first.payload.requestId } }), 0)
    const normal = await crm(action, first.payload)
    assert.equal(normal.status, 200, JSON.stringify(await normal.clone().json()))
    const draft = await db.mutationDraft.findUniqueOrThrow({
      where: { actorId_requestKey: { actorId: adminId, requestKey: first.payload.requestId } },
    })
    assert.equal(JSON.stringify(draft.payload).includes(password), false)
    assert.equal('password' in (draft.payload as object), false)
    assert.equal('newPassword' in (draft.payload as object), false)
    const reloaded = createPostgresRouter(db, createPostgresAuth(db, process.env), process.env)
    const accepted = await reloaded(
      request('mutation-drafts', { requestId: first.payload.requestId, mode: 'recover' }),
      ['mutation-drafts'],
    )
    assert.equal(accepted.status, 200)
    assert.equal((await accepted.json()).confirmed, true)

    const pending = await fixture(action)
    await db.$executeRawUnsafe(
      `CREATE FUNCTION matrix_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' THEN RAISE EXCEPTION 'fictional SQL failure'; END IF; RETURN NEW; END $$`,
    )
    await db.$executeRawUnsafe(
      'CREATE TRIGGER matrix_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION matrix_fail_audit()',
    )
    try {
      assert.equal((await crm(action, pending.payload)).status, 503)
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER matrix_fail_audit ON audit_events')
      await db.$executeRawUnsafe('DROP FUNCTION matrix_fail_audit()')
    }
    assert.equal(
      await db.mutationRequest.count({ where: { actorId: adminId, requestKey: pending.payload.requestId } }),
      0,
    )
    const intent = await db.mutationDraft.findUniqueOrThrow({
      where: { actorId_requestKey: { actorId: adminId, requestKey: pending.payload.requestId } },
    })
    if (intent.requiresCredential) {
      assert.equal(
        (await call('mutation-drafts', { requestId: pending.payload.requestId, mode: 'recover' })).status,
        422,
      )
      assert.equal(
        (
          await call('mutation-drafts', {
            requestId: pending.payload.requestId,
            mode: 'recover',
            password: password + '-different',
          })
        ).status,
        409,
      )
    }
    const recovered = await call('mutation-drafts', {
      requestId: pending.payload.requestId,
      mode: 'recover',
      ...(intent.requiresCredential ? { password } : {}),
    })
    assert.equal(recovered.status, 200, JSON.stringify(await recovered.clone().json()))
    assert.equal((await call('mutation-drafts', { requestId: pending.payload.requestId, mode: 'recover' })).status, 200)
    assert.equal(
      await db.mutationRequest.count({ where: { actorId: adminId, requestKey: pending.payload.requestId } }),
      1,
    )
    if (action === 'resetCoachPassword')
      assert.equal(
        await verifyPassword({
          password,
          hash: (await db.account.findFirstOrThrow({ where: { userId: pending.user.id, providerId: 'credential' } }))
            .password!,
        }),
        true,
      )
    const cleaned = await db.mutationDraft.findUniqueOrThrow({ where: { id: intent.id } })
    assert.equal(cleaned.state, 'acknowledged')
    assert.deepEqual(cleaned.payload, {})
  })
