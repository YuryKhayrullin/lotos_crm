import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
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
let admin = '',
  coach = '',
  second = '',
  branch = '',
  otherBranch = '',
  coachId = '',
  secondId = '',
  adminId = ''
async function call(path: string, input: unknown, cookie = admin) {
  return route(
    new Request(process.env.APP_URL + '/api/' + path, {
      method: 'POST',
      headers: { origin: process.env.APP_URL!, 'content-type': 'application/json', cookie },
      body: JSON.stringify(input),
    }),
    path.split('/'),
  )
}
async function login(username: string) {
  const response = await call('auth/login', { username, password }, '')
  assert.equal(response.status, 200)
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
}
const crm = (action: string, payload: unknown, cookie = admin) => call('crm', { action, payload }, cookie)
async function ok(action: string, payload: unknown, cookie = admin) {
  const response = await crm(action, payload, cookie)
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  return response.json()
}
async function pupil(credits = 0, branchId = branch) {
  const result = await ok('createClient', {
    requestId: randomUUID(),
    branchId,
    childName: 'Fictional pupil',
    parentName: 'Private parent',
  })
  // Explicit TEST-ONLY verified opening journal, never an application credit API.
  if (credits)
    await db.$transaction(async (tx) => {
      const marker = await tx.mutationRequest.create({
        data: {
          actorId: adminId,
          requestKey: randomUUID(),
          action: 'fixture',
          fingerprint: 'a'.repeat(64),
          result: {},
        },
      })
      await tx.lessonLedgerEntry.create({
        data: {
          clientId: result.id,
          branchId,
          actorId: adminId,
          requestId: marker.id,
          type: 'opening_balance',
          sequence: 1,
          lessonsDelta: credits,
          totalLessonsDelta: credits,
          balanceBefore: 0,
          balanceAfter: credits,
          totalBefore: 0,
          totalAfter: credits,
          reason: 'Fictional test opening balance',
        },
      })
      await tx.client.update({
        where: { id: result.id },
        data: { totalLessons: credits, remainingLessons: credits, ledgerVersion: 1 },
      })
    })
  return result.id as string
}
const lessonInput = (clientIds: string[] = [], extra = {}) => ({
  requestId: randomUUID(),
  branchId: branch,
  coachId,
  title: 'Fictional swimming',
  date: '2030-10-07',
  time: '17:00',
  clientIds,
  ...extra,
})
async function lesson(clientIds: string[] = [], extra = {}, identity = admin) {
  return ok('createLesson', lessonInput(clientIds, extra), identity)
}
const marks = (
  lesson: { id: string; date: string; version: number },
  clientId: string,
  status: 'attended' | 'absent',
  expectedVersion = 0,
) => ({
  requestId: randomUUID(),
  expectedLessonVersion: lesson.version,
  attendance: [{ clientId, lessonId: lesson.id, date: lesson.date, status, expectedVersion }],
})
before(async () => {
  // This suite shares a disposable database with catalog tests. Production
  // bootstrap still prohibits a second administrator.
  const fixture = await db.user.create({
    data: {
      username: 'core-admin',
      name: 'Fictional core admin',
      email: 'core@example.invalid',
      role: 'admin',
      status: 'active',
    },
  })
  await db.account.create({
    data: {
      userId: fixture.id,
      accountId: fixture.id,
      providerId: 'credential',
      password: await hashPassword(password),
    },
  })
  admin = await login('core-admin')
  adminId = (await db.user.findUniqueOrThrow({ where: { username: 'core-admin' } })).id
  branch = (await ok('createBranch', { requestId: randomUUID(), name: 'Core fictional pool', address: 'Test' })).id
  otherBranch = (
    await ok('createBranch', { requestId: randomUUID(), name: 'Other core fictional pool', address: 'Test' })
  ).id
  coachId = (
    await ok('createCoach', {
      requestId: randomUUID(),
      branchId: branch,
      name: 'Same name',
      username: 'core-coach',
      password,
    })
  ).id
  secondId = (
    await ok('createCoach', {
      requestId: randomUUID(),
      branchId: branch,
      name: 'Same name',
      username: 'core-second',
      password,
    })
  ).id
  coach = await login('core-coach')
  second = await login('core-second')
})
after(async () => {
  await db.$disconnect()
})

test('assigned identity, not name or creator, governs coach edits and cancellations', async () => {
  const own = await lesson(),
    other = await lesson([], { coachId: secondId })
  await ok('updateLesson', { id: own.id, expectedVersion: 1, requestId: randomUUID(), title: 'Updated' }, coach)
  assert.equal(
    (
      await crm(
        'updateLesson',
        { id: other.id, expectedVersion: 1, requestId: randomUUID(), title: 'Forbidden' },
        coach,
      )
    ).status,
    403,
  )
  assert.equal(
    (await crm('cancelLesson', { id: other.id, expectedVersion: 1, requestId: randomUUID(), reason: 'Test' }, coach))
      .status,
    403,
  )
  assert.equal(
    (await crm('deleteLesson', { id: own.id, expectedVersion: 2, requestId: randomUUID() }, coach)).status,
    403,
  )
  await ok('cancelLesson', { id: own.id, expectedVersion: 2, requestId: randomUUID(), reason: 'Test' }, coach)
})
test('coach creates only for self and current branch; input cannot overwrite scope', async () => {
  assert.equal((await crm('createLesson', lessonInput([], { branchId: otherBranch }), coach)).status, 403)
  assert.equal((await crm('createLesson', lessonInput([], { coachId: secondId }), coach)).status, 403)
  const own = await lesson([], {}, coach)
  assert.equal(own.coachId, coachId)
})
test('creation and weekly instances are durable, atomic and conflict-aware', async () => {
  const client = await pupil(),
    input = lessonInput([client], { isRecurring: true, endDate: '2030-10-21' })
  const first = await ok('createLessonWithClients', input),
    repeat = await ok('createLessonWithClients', input)
  assert.equal(first.id, repeat.id)
  assert.equal(first.occurrencesCreated, 3)
  assert.equal(await db.lesson.count({ where: { seriesId: first.seriesId } }), 3)
  assert.equal(await db.lessonEnrollment.count({ where: { lesson: { seriesId: first.seriesId } } }), 3)
  assert.equal((await crm('createLessonWithClients', { ...input, title: 'Changed' })).status, 409)
  const foreign = await pupil(0, otherBranch),
    invalid = lessonInput([client, foreign])
  assert.equal((await crm('createLesson', invalid)).status, 403)
  assert.equal(await db.mutationRequest.count({ where: { requestKey: invalid.requestId } }), 0)
})
test('empty group stays empty; unknown historical group fails closed; roster omits private fields', async () => {
  const empty = await lesson()
  assert.equal((await ok('getLessonRoster', { lessonId: empty.id, date: empty.date }, coach)).clients.length, 0)
  const client = await pupil(),
    active = await lesson([client])
  const roster = await ok('getLessonRoster', { lessonId: active.id, date: active.date }, coach)
  assert.equal(roster.clients[0].parentName, '')
  for (const key of ['phone', 'email', 'paidAmount', 'paymentBalance', 'receiptUrl', 'birthDate'])
    assert.equal(key in roster.clients[0], false)
  await db.lesson.update({ where: { id: active.id }, data: { rosterConfirmed: false } })
  assert.equal((await crm('getLessonRoster', { lessonId: active.id, date: active.date }, coach)).status, 409)
})
test('coach may mark another assigned coach within branch but no unassigned pupil', async () => {
  const client = await pupil(1),
    foreign = await pupil(),
    other = await lesson([client], { coachId: secondId })
  await ok('recordBulkAttendance', marks(other, client, 'attended'), coach)
  assert.equal((await crm('recordBulkAttendance', marks(other, foreign, 'absent'), coach)).status, 403)
})
test('both absent and attended prohibit cancellation, including administrator requests', async () => {
  for (const status of ['absent', 'attended'] as const) {
    const client = await pupil(1),
      own = await lesson([client])
    await ok('recordBulkAttendance', marks(own, client, status), coach)
    for (const identity of [admin, coach])
      assert.equal(
        (
          await crm(
            'cancelLesson',
            { id: own.id, expectedVersion: 1, requestId: randomUUID(), reason: 'Test' },
            identity,
          )
        ).status,
        409,
      )
    assert.equal((await crm('deleteLesson', { id: own.id, expectedVersion: 1, requestId: randomUUID() })).status, 409)
  }
})
test('unlimited historical corrections preserve immutable events; old replay never undoes newer absent', async () => {
  const client = await pupil(1),
    own = await lesson([client])
  await db.lesson.update({
    where: { id: own.id },
    data: {
      localDate: new Date('2010-01-01T00:00:00Z'),
      startsAt: new Date('2010-01-01T14:00:00Z'),
      endsAt: new Date('2010-01-01T15:00:00Z'),
    },
  })
  own.date = '2010-01-01'
  const first = marks(own, client, 'attended')
  await ok('recordBulkAttendance', first, second)
  await ok('recordBulkAttendance', marks(own, client, 'absent', 1), coach)
  const replay = await ok('recordBulkAttendance', first, second)
  assert.equal(replay.results[0].duplicate, true)
  assert.equal(replay.results[0].client.remainingLessons, 1)
  assert.equal((await db.attendance.findFirstOrThrow({ where: { clientId: client } })).status, 'absent')
  assert.equal(await db.attendanceEvent.count({ where: { clientId: client } }), 2)
  assert.equal((await crm('recordBulkAttendance', marks(own, client, 'attended', 1), coach)).status, 409)
})
test('one invalid mark rejects the entire packet without partial balances, events or confirmation', async () => {
  const a = await pupil(1),
    b = await pupil(),
    own = await lesson([a, b])
  const input = marks(own, a, 'attended')
  input.attendance.push({ ...input.attendance[0], clientId: b })
  assert.equal((await crm('recordBulkAttendance', input, coach)).status, 409)
  assert.equal(await db.attendance.count({ where: { lessonId: own.id } }), 0)
  assert.equal(await db.mutationRequest.count({ where: { requestKey: input.requestId } }), 0)
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: a } })).remainingLessons, 1)
})
test('parallel different lessons cannot spend the last credit twice', async () => {
  const client = await pupil(1),
    one = await lesson([client]),
    two = await lesson([client])
  const results = await Promise.all([
    crm('recordBulkAttendance', marks(one, client, 'attended'), coach),
    crm('recordBulkAttendance', marks(two, client, 'attended'), second),
  ])
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 409])
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: client } })).remainingLessons, 0)
  assert.equal(await db.attendanceEvent.count({ where: { clientId: client } }), 1)
})
test('server-side recovery survives commit and lost reply until acknowledgement; no names in stored payload', async () => {
  const client = await pupil(1),
    own = await lesson([client]),
    input = marks(own, client, 'attended')
  await ok('prepareAttendance', input, coach)
  assert.equal((await crm('acknowledgeAttendance', { requestId: input.requestId }, coach)).status, 409)
  await ok('recordBulkAttendance', input, coach) // discard original response to simulate lost acknowledgement
  const roster = await ok('getLessonRoster', { lessonId: own.id, date: own.date }, coach)
  assert.equal(roster.pendingAttempt.requestId, input.requestId)
  assert.equal((await ok('getLessonRoster', { lessonId: own.id, date: own.date }, second)).pendingAttempt, null)
  const draft = await db.attendanceDraft.findFirstOrThrow({ where: { requestKey: input.requestId } })
  assert.equal(JSON.stringify(draft.payload).includes('Fictional'), false)
  await ok('recordBulkAttendance', input, coach)
  await ok('acknowledgeAttendance', { requestId: input.requestId }, coach)
  assert.equal((await ok('getLessonRoster', { lessonId: own.id, date: own.date }, coach)).pendingAttempt, null)
  assert.equal(await db.attendanceEvent.count({ where: { clientId: client } }), 1)
})
test('safe deletion cleans enrollment links; ordinary update cannot change group or branch', async () => {
  const client = await pupil(),
    own = await lesson([client]),
    deletion = { id: own.id, requestId: randomUUID(), expectedVersion: 1 }
  for (const extra of [{ branchId: otherBranch }, { clientIds: [] }, { createdById: adminId }])
    assert.equal((await crm('updateLesson', { ...deletion, ...extra })).status, 400)
  await ok('deleteLesson', deletion)
  await ok('deleteLesson', deletion)
  assert.equal(await db.lessonEnrollment.count({ where: { lessonId: own.id } }), 0)
})
test('card-journal discrepancy blocks attendance instead of inventing an opening balance', async () => {
  const client = await pupil(),
    own = await lesson([client])
  await db.client.update({ where: { id: client }, data: { totalLessons: 1, remainingLessons: 1 } })
  assert.equal((await crm('recordBulkAttendance', marks(own, client, 'attended'), coach)).status, 409)
  assert.equal(await db.attendanceEvent.count({ where: { clientId: client } }), 0)
})
test('context versions reject stale rosters; archived history survives and cannot be silently rewritten', async () => {
  const client = await pupil(1),
    own = await lesson([client])
  await ok('updateLesson', { id: own.id, expectedVersion: 1, requestId: randomUUID(), title: 'New context' }, coach)
  assert.equal((await crm('recordBulkAttendance', marks(own, client, 'attended'), coach)).status, 409)
  own.version = 2
  await ok('recordBulkAttendance', marks(own, client, 'attended'), coach)
  const row = await db.client.findUniqueOrThrow({ where: { id: client } })
  await ok('updateClient', { id: client, expectedVersion: row.version, requestId: randomUUID(), status: 'Архив' })
  const roster = await ok('getLessonRoster', { lessonId: own.id, date: own.date }, coach)
  assert.equal(roster.clients[0].mark, 'attended')
  assert.equal(roster.clients[0].canMark, false)
  const history = await ok('getClientHistory', { clientId: client })
  assert.equal(history.attendanceHistory[0].lessonContext.title, 'New context')
  assert.equal(history.attendanceHistory[0].lessonContext.canEdit, undefined)
  assert.equal((await crm('recordBulkAttendance', marks(own, client, 'absent', 1), coach)).status, 409)
})
test('attendance audit failure rolls back every mark and leaves a safe recoverable original attempt', async () => {
  const client = await pupil(1),
    own = await lesson([client]),
    input = marks(own, client, 'attended')
  await db.$executeRawUnsafe(
    "CREATE FUNCTION test_attendance_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'recordBulkAttendance' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$",
  )
  await db.$executeRawUnsafe(
    'CREATE TRIGGER test_attendance_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_attendance_audit_failure()',
  )
  try {
    assert.equal((await crm('recordBulkAttendance', input, coach)).status, 503)
    assert.equal(await db.attendance.count({ where: { lessonId: own.id } }), 0)
    assert.equal(await db.attendanceEvent.count({ where: { clientId: client } }), 0)
    assert.equal(await db.mutationRequest.count({ where: { requestKey: input.requestId } }), 0)
    assert.equal((await db.client.findUniqueOrThrow({ where: { id: client } })).remainingLessons, 1)
    assert.equal(
      (await ok('getLessonRoster', { lessonId: own.id, date: own.date }, coach)).pendingAttempt.requestId,
      input.requestId,
    )
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER test_attendance_audit_failure ON audit_events')
    await db.$executeRawUnsafe('DROP FUNCTION test_attendance_audit_failure()')
  }
  await ok('recordBulkAttendance', input, coach)
  assert.equal(await db.attendanceEvent.count({ where: { clientId: client } }), 1)
})
test('schedule windows and dates are explicit; forged occurrence date and oversized packets are rejected', async () => {
  const client = await pupil(),
    own = await lesson([client])
  const window = await ok('getSchedule', { from: '2030-10-07', to: '2030-10-07' }, coach)
  assert.ok(window.items.some((entry: { id: string }) => entry.id === own.id))
  assert.equal(
    (await ok('getSchedule', { from: '2010-01-01', to: '2010-01-01' }, coach)).items.every(
      (entry: { date: string }) => entry.date === '2010-01-01',
    ),
    true,
  )
  assert.equal((await crm('getLessonRoster', { lessonId: own.id, date: '2030-10-08' }, coach)).status, 409)
  const input = marks(own, client, 'absent')
  assert.equal(
    (await crm('recordBulkAttendance', { ...input, attendance: Array(101).fill(input.attendance[0]) }, coach)).status,
    400,
  )
})
test('one hundred absent marks form one transaction, not partial chunks or invented credits', async () => {
  const ids = Array.from({ length: 100 }, () => randomUUID())
  await db.client.createMany({
    data: ids.map((id) => ({ id, branchId: branch, childName: 'Batch fictional pupil', parentName: 'Test' })),
  })
  const own = await lesson(ids, { maxCapacity: 100 })
  const input = {
    requestId: randomUUID(),
    expectedLessonVersion: 1,
    attendance: ids.map((clientId) => ({
      clientId,
      lessonId: own.id,
      date: own.date,
      status: 'absent',
      expectedVersion: 0,
    })),
  }
  const result = await ok('recordBulkAttendance', input, coach)
  assert.equal(result.results.length, 100)
  assert.equal(await db.attendance.count({ where: { lessonId: own.id } }), 100)
  assert.equal(await db.mutationRequest.count({ where: { requestKey: input.requestId } }), 1)
  assert.equal(await db.client.count({ where: { id: { in: ids }, remainingLessons: { not: 0 } } }), 0)
})
test('DST gap in a recurring instance rolls back its whole series and roster', async () => {
  const berlin = await ok('createBranch', {
    requestId: randomUUID(),
    name: 'Berlin fictional pool',
    address: 'Test',
    timeZone: 'Europe/Berlin',
  })
  const profile = await ok('createCoach', { requestId: randomUUID(), name: 'Berlin test', branchId: berlin.id })
  const input = lessonInput([], {
    branchId: berlin.id,
    coachId: profile.id,
    date: '2030-03-24',
    time: '02:30',
    isRecurring: true,
    endDate: '2030-03-31',
  })
  assert.equal((await crm('createLesson', input)).status, 400)
  assert.equal(await db.lesson.count({ where: { branchId: berlin.id } }), 0)
  assert.equal(await db.lessonSeries.count({ where: { branchId: berlin.id } }), 0)
  assert.equal(await db.mutationRequest.count({ where: { requestKey: input.requestId } }), 0)
})
test('branch reassignment revokes old cookies and denies historical access even for a durable retry', async () => {
  const client = await pupil(1),
    own = await lesson([client]),
    input = marks(own, client, 'attended')
  await ok('recordBulkAttendance', input, coach)
  const user = await db.user.findUniqueOrThrow({ where: { username: 'core-coach' } })
  await ok('assignUserBranch', { userId: user.id, branchId: otherBranch, requestId: randomUUID() })
  assert.equal((await crm('recordBulkAttendance', input, coach)).status, 401)
  const moved = await login('core-coach')
  assert.equal((await crm('recordBulkAttendance', input, moved)).status, 403)
  assert.equal((await crm('getLessonRoster', { lessonId: own.id, date: own.date }, moved)).status, 403)
  assert.equal(await db.attendanceEvent.count({ where: { clientId: client } }), 1)
})
