import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client as PgClient } from 'pg'
import { hashPassword } from 'better-auth/crypto'
import { createPostgresClient, getPostgresClient } from '../../lib/server/postgres/client'
import { createPostgresAuth } from '../../lib/server/postgres/auth'
import {
  creditProjectionSchema,
  dateOnlySchema,
  moneyMinorSchema,
  timeZoneSchema,
  usernameSchema,
} from '../../lib/server/postgres/validation'
import { validateEnvironment } from '../../scripts/lib/environment.mjs'

// Refuse even the persistent LOCAL database: this suite owns only a disposable
// database, created and removed by scripts/environment.mjs integration test.
validateEnvironment(process.env, 'test')
const db = createPostgresClient(process.env)
const auth = createPostgresAuth(db, process.env)
const password = randomBytes(24).toString('hex')
const ids = {
  admin: randomUUID(),
  branch: randomUUID(),
  otherBranch: randomUUID(),
  coach: randomUUID(),
  otherCoach: randomUUID(),
  client: randomUUID(),
  otherClient: randomUUID(),
  lesson: randomUUID(),
  enrollment: randomUUID(),
}

before(async () => {
  assert.deepEqual(await db.$queryRaw`SELECT current_database() AS name`, [{ name: 'lotos_crm_test' }])
  await db.branch.createMany({
    data: [
      { id: ids.branch, name: 'Test pool', address: 'Fictional address' },
      { id: ids.otherBranch, name: 'Other test pool', address: 'Fictional address' },
    ],
  })
  await db.user.create({
    data: {
      id: ids.admin,
      name: 'Test admin',
      username: 'test-admin',
      email: 'admin@example.test',
      role: 'admin',
      status: 'active',
    },
  })
  await db.account.create({
    data: { userId: ids.admin, providerId: 'credential', accountId: ids.admin, password: await hashPassword(password) },
  })
  await db.coach.createMany({
    data: [
      { id: ids.coach, branchId: ids.branch, name: 'Test coach' },
      { id: ids.otherCoach, branchId: ids.otherBranch, name: 'Other coach' },
    ],
  })
  await db.coachBranch.createMany({
    data: [
      { coachId: ids.coach, branchId: ids.branch },
      { coachId: ids.otherCoach, branchId: ids.otherBranch },
    ],
  })
  await db.client.createMany({
    data: [
      {
        id: ids.client,
        branchId: ids.branch,
        childName: 'Test child',
        parentName: 'Test parent',
        totalLessons: 4,
        remainingLessons: 4,
        birthDate: new Date('2015-12-31T00:00:00Z'),
      },
      { id: ids.otherClient, branchId: ids.otherBranch, childName: 'Other child', parentName: 'Other parent' },
    ],
  })
  await db.lesson.create({
    data: {
      id: ids.lesson,
      branchId: ids.branch,
      coachId: ids.coach,
      createdById: ids.admin,
      title: 'Test swimming',
      category: 'swimming',
      localDate: new Date('2026-10-07T00:00:00Z'),
      timeZone: 'Europe/Moscow',
      startsAt: new Date('2026-10-07T14:00:00Z'),
      endsAt: new Date('2026-10-07T15:00:00Z'),
    },
  })
  await db.lessonEnrollment.create({
    data: { id: ids.enrollment, lessonId: ids.lesson, clientId: ids.client, branchId: ids.branch },
  })
  await db.$transaction(async (tx) => {
    const request = await tx.mutationRequest.create({ data: requestData('opening-fixture') })
    await tx.lessonLedgerEntry.create({
      data: {
        clientId: ids.client,
        branchId: ids.branch,
        actorId: ids.admin,
        requestId: request.id,
        type: 'opening_balance',
        sequence: 1,
        lessonsDelta: 4,
        totalLessonsDelta: 4,
        balanceBefore: 0,
        balanceAfter: 4,
        totalBefore: 0,
        totalAfter: 4,
        reason: 'Fictional opening balance',
        createdAt: new Date('2026-10-01T00:00:00Z'),
      },
    })
    await tx.client.update({ where: { id: ids.client }, data: { ledgerVersion: 1 } })
  })
})
after(async () => {
  await db.$disconnect()
  await getPostgresClient(process.env).$disconnect()
})

test('runtime lazily reuses one Prisma pool and rejects an environment switch', () => {
  assert.equal(getPostgresClient(process.env), getPostgresClient(process.env))
  assert.throws(() => getPostgresClient({ ...process.env, APP_ENV: 'production' }))
})

const requestData = (key: string) => ({
  actorId: ids.admin,
  requestKey: key,
  action: 'foundation-test',
  fingerprint: 'a'.repeat(64),
  result: { success: true },
})

test('fresh database has all versioned migrations and no failed migration', async () => {
  const rows = await db.$queryRaw<
    Array<{ migration_name: string; finished_at: Date | null }>
  >`SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY migration_name`
  assert.equal(rows.length, 9)
  assert.ok(rows.every((row) => row.finished_at instanceof Date))
})

test('Zod rejects nonfinite/fractional credits, impossible dates, unknown fields and unsafe money', () => {
  for (const value of [NaN, Infinity, -1, 0.5])
    assert.equal(creditProjectionSchema.safeParse({ remainingLessons: value, totalLessons: 4 }).success, false)
  assert.equal(creditProjectionSchema.safeParse({ remainingLessons: 5, totalLessons: 4 }).success, false)
  assert.equal(creditProjectionSchema.safeParse({ remainingLessons: 0, totalLessons: 4, role: 'admin' }).success, false)
  assert.equal(dateOnlySchema.safeParse('2026-02-30').success, false)
  assert.equal(timeZoneSchema.safeParse('Not/AZone').success, false)
  assert.equal(moneyMinorSchema.safeParse('1.50').success, false)
  assert.equal(moneyMinorSchema.safeParse('9223372036854775808').success, false)
  assert.equal(moneyMinorSchema.parse('9007199254740993'), BigInt('9007199254740993'))
  assert.equal(usernameSchema.parse(' TEST-COACH '), 'test-coach')
})

test('client factory fails closed before connecting to a foreign or mismatched database', () => {
  assert.throws(() =>
    createPostgresClient({ ...process.env, DATABASE_URL: 'postgresql://invalid@remote.example:5432/production' }),
  )
  assert.throws(() => createPostgresClient({ ...process.env, APP_ENV: 'production' }))
  assert.throws(() => createPostgresAuth(db, { ...process.env, BETTER_AUTH_SECRET: '' }))
})

test('username uniqueness and canonical spelling are enforced in PostgreSQL', async () => {
  await assert.rejects(db.user.create({ data: { name: 'Duplicate', username: 'test-admin' } }))
  await assert.rejects(db.user.create({ data: { name: 'Mixed case', username: 'Test-Admin' } }))
  await assert.rejects(db.user.create({ data: { name: 'Mixed email', email: 'Admin@Example.test' } }))
  const pending = await db.user.create({ data: { name: 'Pending', username: 'pending-coach' } })
  assert.equal(pending.role, 'coach')
  assert.equal(pending.status, 'pending')
  assert.equal(pending.email, null)
})

test('PostgreSQL rejects invalid credit balances and negative monetary values', async () => {
  for (const data of [
    { remainingLessons: -1 },
    { remainingLessons: 5 },
    { totalLessons: -1 },
    { paidAmountMinor: BigInt(-1) },
    { paymentBalanceMinor: BigInt(-1) },
    { lessonsPerWeek: 4 },
  ])
    await assert.rejects(db.client.update({ where: { id: ids.client }, data }))
  const client = await db.client.findUniqueOrThrow({ where: { id: ids.client } })
  assert.equal(client.remainingLessons, 4)
})

test('dates are DATE values and money does not lose precision above JavaScript safe integers', async () => {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'America/Los_Angeles'`
    await tx.client.update({ where: { id: ids.client }, data: { paidAmountMinor: BigInt('9007199254740993') } })
    const client = await tx.client.findUniqueOrThrow({ where: { id: ids.client } })
    assert.equal(client.birthDate?.toISOString(), '2015-12-31T00:00:00.000Z')
    assert.equal(client.paidAmountMinor, BigInt('9007199254740993'))
  })
})

test('enrollment is unique and cannot connect a lesson with a client from another branch', async () => {
  await assert.rejects(
    db.lessonEnrollment.create({ data: { lessonId: ids.lesson, clientId: ids.client, branchId: ids.branch } }),
  )
  await assert.rejects(
    db.lessonEnrollment.create({ data: { lessonId: ids.lesson, clientId: ids.otherClient, branchId: ids.branch } }),
  )
  await assert.rejects(
    db.lessonEnrollment.create({
      data: { lessonId: ids.lesson, clientId: ids.otherClient, branchId: ids.otherBranch },
    }),
  )
  assert.equal(await db.lessonEnrollment.count({ where: { lessonId: ids.lesson } }), 1)
})

test('lesson and series cannot use a coach from another branch', async () => {
  await assert.rejects(db.lesson.update({ where: { id: ids.lesson }, data: { coachId: ids.otherCoach } }))
})

test('occurrence time, local date, time zone and cancellation metadata agree', async () => {
  await assert.rejects(db.lesson.update({ where: { id: ids.lesson }, data: { localDate: new Date('2026-10-06') } }))
  await assert.rejects(
    db.lesson.update({ where: { id: ids.lesson }, data: { endsAt: new Date('2026-10-07T13:00:00Z') } }),
  )
  await assert.rejects(db.lesson.update({ where: { id: ids.lesson }, data: { timeZone: 'Invalid/Zone' } }))
  await assert.rejects(db.lesson.update({ where: { id: ids.lesson }, data: { status: 'cancelled' } }))
})

test('recurring series and explicit occurrences have unique dates; empty roster stays empty', async () => {
  const series = await db.lessonSeries.create({
    data: {
      branchId: ids.branch,
      coachId: ids.coach,
      title: 'Weekly',
      category: 'swimming',
      startDate: new Date('2026-10-07'),
      localTime: new Date('1970-01-01T17:00:00Z'),
      timeZone: 'Europe/Moscow',
      weekdays: [3],
    },
  })
  await assert.rejects(db.lessonSeries.update({ where: { id: series.id }, data: { weekdays: [7] } }))
  const data = {
    branchId: ids.branch,
    coachId: ids.coach,
    seriesId: series.id,
    createdById: ids.admin,
    title: 'Weekly occurrence',
    category: 'swimming' as const,
    localDate: new Date('2026-10-14'),
    timeZone: 'Europe/Moscow',
    startsAt: new Date('2026-10-14T14:00:00Z'),
    endsAt: new Date('2026-10-14T15:00:00Z'),
  }
  const lesson = await db.lesson.create({ data })
  await assert.rejects(db.lesson.create({ data }))
  assert.equal(await db.lessonEnrollment.count({ where: { lessonId: lesson.id } }), 0)
  await assert.rejects(
    db.seriesEnrollment.create({
      data: {
        seriesId: series.id,
        clientId: ids.otherClient,
        branchId: ids.branch,
        effectiveFrom: new Date('2026-10-07'),
      },
    }),
  )
})

test('durable request namespace is per actor, not cache and not per action', async () => {
  const confirmed = await db.mutationRequest.create({ data: requestData('request-one') })
  await assert.rejects(db.mutationRequest.create({ data: { ...requestData('request-one'), action: 'other-action' } }))
  assert.deepEqual(
    (
      await db.mutationRequest.findUniqueOrThrow({
        where: { actorId_requestKey: { actorId: ids.admin, requestKey: 'request-one' } },
      })
    ).result,
    { success: true },
  )
  await assert.rejects(db.mutationRequest.update({ where: { id: confirmed.id }, data: { result: { success: false } } }))
  await assert.rejects(db.mutationRequest.delete({ where: { id: confirmed.id } }))
})

test('current attendance must refer to its exact enrollment and has one current mark', async () => {
  const attendance = await db.attendance.create({
    data: {
      enrollmentId: ids.enrollment,
      lessonId: ids.lesson,
      clientId: ids.client,
      branchId: ids.branch,
      status: 'attended',
    },
  })
  const data = {
    enrollmentId: ids.enrollment,
    lessonId: ids.lesson,
    clientId: ids.client,
    branchId: ids.branch,
    status: 'absent' as const,
  }
  await assert.rejects(db.attendance.create({ data }))
  await assert.rejects(db.attendance.update({ where: { id: attendance.id }, data: { clientId: ids.otherClient } }))
  await assert.rejects(db.lessonEnrollment.delete({ where: { id: ids.enrollment } }))
})

test('payment and ledger persist atomically; exact values and links are preserved', async () => {
  await db.$transaction(async (tx) => {
    const request = await tx.mutationRequest.create({ data: requestData('payment-success') })
    const payment = await tx.payment.create({
      data: {
        clientId: ids.client,
        branchId: ids.branch,
        requestId: request.id,
        actorId: ids.admin,
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
    await tx.lessonLedgerEntry.create({
      data: {
        clientId: ids.client,
        branchId: ids.branch,
        requestId: request.id,
        actorId: ids.admin,
        paymentId: payment.id,
        type: 'purchase',
        lessonsDelta: 4,
        totalLessonsDelta: 4,
        balanceBefore: 4,
        balanceAfter: 8,
        totalBefore: 4,
        totalAfter: 8,
        reason: 'Test payment',
        sequence: 2,
        createdAt: new Date('2026-10-01T00:00:00Z'),
      },
    })
    await tx.client.update({
      where: { id: ids.client },
      data: { remainingLessons: 8, totalLessons: 8, ledgerVersion: 2 },
    })
  })
  const payment = await db.payment.findFirstOrThrow({ where: { clientId: ids.client } })
  assert.equal(payment.amountMinor, BigInt(550000))
  await assert.rejects(db.payment.update({ where: { id: payment.id }, data: { lessonsAdded: 5 } }))
  await assert.rejects(db.payment.delete({ where: { id: payment.id } }))
})

test('failed cross-table transaction rolls back balances and durable confirmation', async () => {
  await assert.rejects(
    db.$transaction(async (tx) => {
      await tx.mutationRequest.create({ data: requestData('rolled-back') })
      await tx.client.update({ where: { id: ids.client }, data: { remainingLessons: 7 } })
      await tx.lessonEnrollment.create({
        data: { lessonId: ids.lesson, clientId: ids.otherClient, branchId: ids.branch },
      })
    }),
  )
  assert.equal(await db.mutationRequest.count({ where: { requestKey: 'rolled-back' } }), 0)
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: ids.client } })).remainingLessons, 8)
})

test('attendance change history and credit ledger cannot be rewritten or cascade-deleted', async () => {
  const attendance = await db.attendance.findUniqueOrThrow({
    where: { lessonId_clientId: { lessonId: ids.lesson, clientId: ids.client } },
  })
  const request = await db.mutationRequest.create({ data: requestData('attendance-history') })
  const event = await db.attendanceEvent.create({
    data: {
      attendanceId: attendance.id,
      clientId: ids.client,
      branchId: ids.branch,
      requestId: request.id,
      actorId: ids.admin,
      status: 'attended',
      version: 1,
    },
  })
  await assert.rejects(
    db.attendanceEvent.create({
      data: {
        attendanceId: attendance.id,
        clientId: ids.client,
        branchId: ids.branch,
        requestId: request.id,
        actorId: ids.admin,
        status: 'absent',
        version: 1,
      },
    }),
  )
  await assert.rejects(db.attendanceEvent.update({ where: { id: event.id }, data: { status: 'absent' } }))
  await assert.rejects(db.attendanceEvent.delete({ where: { id: event.id } }))
  const ledger = await db.lessonLedgerEntry.findFirstOrThrow({ where: { clientId: ids.client } })
  await assert.rejects(db.lessonLedgerEntry.delete({ where: { id: ledger.id } }))
  await assert.rejects(db.attendance.delete({ where: { id: attendance.id } }))
  await assert.rejects(db.lesson.delete({ where: { id: ids.lesson } }))
  await assert.rejects(db.client.delete({ where: { id: ids.client } }))
  await assert.rejects(db.coach.delete({ where: { id: ids.coach } }))
  await assert.rejects(db.user.delete({ where: { id: ids.admin } }))
})

test('receipt metadata rejects public paths, unsupported types and oversized files', async () => {
  const request = await db.mutationRequest.create({ data: requestData('receipt-test') })
  const data = {
    clientId: ids.client,
    branchId: ids.branch,
    requestId: request.id,
    uploadedById: ids.admin,
    storageKey: randomUUID().replaceAll('-', ''),
    originalName: 'receipt.pdf',
    mimeType: 'application/pdf',
    sizeBytes: BigInt(100),
    sha256: 'b'.repeat(64),
  }
  for (const invalid of [
    { storageKey: '../public/receipt.pdf' },
    { mimeType: 'text/html' },
    { sizeBytes: BigInt(5242881) },
    { sha256: 'invalid' },
  ])
    await assert.rejects(db.document.create({ data: { ...data, ...invalid } }))
  await db.document.create({ data })
})

test('Better Auth username login uses Prisma sessions; signup and username enumeration stay disabled', async () => {
  const response = await auth.handler(
    new Request(process.env.APP_URL + '/api/auth/sign-in/username', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: process.env.APP_URL! },
      body: JSON.stringify({ username: 'TEST-ADMIN', password }),
    }),
  )
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.user.id, ids.admin)
  assert.equal(payload.user.role, 'admin')
  assert.equal(Object.hasOwn(payload.user, 'password'), false)
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  assert.ok(cookie.includes('session_token='))
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  assert.equal(session?.user.id, ids.admin)
  assert.equal(await db.session.count({ where: { userId: ids.admin } }), 1)
  // With cookieCache disabled, current profile is read through Prisma.
  await db.user.update({ where: { id: ids.admin }, data: { name: 'Updated admin' } })
  assert.equal((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.name, 'Updated admin')
  const signOut = await auth.handler(
    new Request(process.env.APP_URL + '/api/auth/sign-out', {
      method: 'POST',
      headers: { cookie, origin: process.env.APP_URL! },
    }),
  )
  assert.equal(signOut.status, 200)
  assert.equal(await db.session.count({ where: { userId: ids.admin } }), 0)
  assert.equal(await auth.api.getSession({ headers: new Headers({ cookie }) }), null)
  const signUp = await auth.handler(
    new Request(process.env.APP_URL + '/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: process.env.APP_URL! },
      body: JSON.stringify({
        name: 'Attacker',
        email: 'attacker@example.test',
        password,
        username: 'attacker',
        role: 'admin',
        status: 'active',
        branchId: ids.branch,
      }),
    }),
  )
  assert.notEqual(signUp.status, 200)
  assert.equal(await db.user.count({ where: { username: 'attacker' } }), 0)
  const available = await auth.handler(
    new Request(process.env.APP_URL + '/api/auth/is-username-available', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'test-admin' }),
    }),
  )
  assert.notEqual(available.status, 200)
})

test('indexes exist for schedule, names, histories and session expiry', async () => {
  const rows = await db.$queryRaw<
    Array<{ indexname: string }>
  >`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
  for (const name of [
    'lessons_branch_id_local_date_starts_at_idx',
    'clients_child_name_prefix_idx',
    'clients_parent_name_prefix_idx',
    'lesson_ledger_client_id_created_at_id_idx',
    'sessions_expires_at_idx',
  ])
    assert.ok(
      rows.some((row) => row.indexname === name),
      name,
    )
})

test('username-only account can use Better Auth without inventing a personal email', async () => {
  const user = await db.user.create({ data: { username: 'no-email-coach', name: 'No email coach', status: 'active' } })
  await db.account.create({
    data: { userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) },
  })
  const response = await auth.handler(
    new Request(process.env.APP_URL + '/api/auth/sign-in/username', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: process.env.APP_URL! },
      body: JSON.stringify({ username: 'no-email-coach', password }),
    }),
  )
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.user.id, user.id)
  assert.equal(result.user.email, null)
  assert.equal(result.user.role, 'coach')
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  assert.equal((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.id, user.id)
  await db.session.deleteMany({ where: { userId: user.id } })
  assert.equal(await auth.api.getSession({ headers: new Headers({ cookie }) }), null)
})

test('pending and disabled accounts do not receive new database sessions', async () => {
  for (const status of ['pending', 'disabled'] as const) {
    const name = status + '-login-coach'
    const user = await db.user.create({ data: { username: name, name, status } })
    await db.account.create({
      data: { userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) },
    })
    const response = await auth.handler(
      new Request(process.env.APP_URL + '/api/auth/sign-in/username', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: process.env.APP_URL! },
        body: JSON.stringify({ username: name, password }),
      }),
    )
    assert.notEqual(response.status, 200)
    assert.equal(await db.session.count({ where: { userId: user.id } }), 0)
  }
})

test('simultaneous duplicate confirmations yield one durable row', async () => {
  const data = requestData('concurrent-request')
  const results = await Promise.allSettled([db.mutationRequest.create({ data }), db.mutationRequest.create({ data })])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(await db.mutationRequest.count({ where: { actorId: ids.admin, requestKey: data.requestKey } }), 1)
})

test('history attributes domain changes to the actor that owns the confirmation', async () => {
  const other = await db.user.create({
    data: { name: 'Another test actor', username: 'another-test-actor', status: 'active' },
  })
  const request = await db.mutationRequest.create({ data: requestData('actor-attribution') })
  await assert.rejects(
    db.auditEvent.create({
      data: {
        actorId: other.id,
        requestId: request.id,
        action: 'test',
        entityType: 'client',
        entityId: ids.client,
        changedFields: ['status'],
      },
    }),
  )
  await assert.rejects(
    db.auditEvent.create({
      data: {
        requestId: request.id,
        action: 'test',
        entityType: 'client',
        entityId: ids.client,
        changedFields: ['status'],
      },
    }),
  )
  const event = await db.auditEvent.create({
    data: {
      actorId: ids.admin,
      requestId: request.id,
      action: 'test',
      entityType: 'client',
      entityId: ids.client,
      changedFields: ['status'],
    },
  })
  await assert.rejects(db.auditEvent.delete({ where: { id: event.id } }))
  // Actor scoping permits independent requests from different accounts.
  await db.mutationRequest.create({ data: { ...requestData('actor-attribution'), actorId: other.id } })
})

test('new sessions capture the server auth version without trusting the browser', async () => {
  const user = await db.user.create({
    data: { username: 'versioned-coach', name: 'Versioned coach', status: 'active', authVersion: 3 },
  })
  await db.account.create({
    data: { userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) },
  })
  const response = await auth.handler(
    new Request(process.env.APP_URL + '/api/auth/sign-in/username', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: process.env.APP_URL! },
      body: JSON.stringify({ username: user.username, password, authVersion: 100, role: 'admin' }),
    }),
  )
  assert.equal(response.status, 200)
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  assert.equal(session?.session.authVersion, 3)
  assert.equal(session?.user.role, 'coach')
  await db.user.update({ where: { id: user.id }, data: { authVersion: 4 } })
  const refreshed = await auth.api.getSession({ headers: new Headers({ cookie }) })
  assert.equal(refreshed?.user.authVersion, 4)
  assert.equal(refreshed?.session.authVersion, 3)
  // Stage 4 must reject this mismatch on EVERY protected application request.
  await db.session.deleteMany({ where: { userId: user.id } })
})

test('ledger arithmetic and package credit snapshot are database constraints, not only validators', async () => {
  const request = await db.mutationRequest.create({ data: requestData('invalid-accounting') })
  const ledger = {
    clientId: ids.client,
    branchId: ids.branch,
    requestId: request.id,
    actorId: ids.admin,
    type: 'adjustment' as const,
    sequence: 3,
    lessonsDelta: 1,
    totalLessonsDelta: 1,
    balanceBefore: 8,
    balanceAfter: 8,
    totalBefore: 8,
    totalAfter: 9,
    reason: 'Invalid arithmetic test',
  }
  await assert.rejects(db.lessonLedgerEntry.create({ data: ledger }))
  await assert.rejects(
    db.payment.create({
      data: {
        clientId: ids.client,
        branchId: ids.branch,
        requestId: request.id,
        actorId: ids.admin,
        amountMinor: BigInt(550000),
        category: 'swimming',
        lessonsPerWeek: 1,
        packagePriceMinor: BigInt(550000),
        packageLessons: 4,
        packagesCount: 1,
        lessonsAdded: 5,
        paidAt: new Date(),
      },
    }),
  )
  assert.equal(await db.lessonLedgerEntry.count({ where: { requestId: request.id } }), 0)
})

test('per-client sequence orders movements unambiguously even with identical timestamps', async () => {
  const entries = await db.lessonLedgerEntry.findMany({ where: { clientId: ids.client }, orderBy: { sequence: 'asc' } })
  assert.deepEqual(
    entries.map((entry) => entry.sequence),
    [1, 2],
  )
  assert.equal(entries[0].createdAt.getTime(), entries[1].createdAt.getTime())
  assert.equal(entries[0].balanceAfter, entries[1].balanceBefore)
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: ids.client } })).ledgerVersion, 2)
  await assert.rejects(db.lessonLedgerEntry.create({ data: { ...entries[0], id: randomUUID() } }))
})

test('reassigning a coach preserves historical lesson branch and stable account identity', async () => {
  const user = await db.user.create({
    data: { username: 'transfer-coach', name: 'Transfer coach', branchId: ids.branch, status: 'active' },
  })
  const coach = await db.coach.create({
    data: { userId: user.id, branchId: ids.branch, name: user.name, memberships: { create: { branchId: ids.branch } } },
  })
  const lesson = await db.lesson.create({
    data: {
      branchId: ids.branch,
      coachId: coach.id,
      createdById: ids.admin,
      title: 'Historical branch lesson',
      category: 'swimming',
      localDate: new Date('2026-10-07'),
      timeZone: 'Europe/Moscow',
      startsAt: new Date('2026-10-07T14:00:00Z'),
      endsAt: new Date('2026-10-07T15:00:00Z'),
    },
  })
  await db.$transaction(async (tx) => {
    await tx.coachBranch.create({ data: { coachId: coach.id, branchId: ids.otherBranch } })
    await tx.coachBranch.update({
      where: { coachId_branchId: { coachId: coach.id, branchId: ids.branch } },
      data: { endedAt: new Date() },
    })
    await tx.coach.update({ where: { id: coach.id }, data: { branchId: ids.otherBranch } })
    await tx.user.update({ where: { id: user.id }, data: { branchId: ids.otherBranch } })
  })
  const unchanged = await db.lesson.findUniqueOrThrow({ where: { id: lesson.id }, include: { coach: true } })
  assert.equal(unchanged.branchId, ids.branch)
  assert.equal(unchanged.coach.userId, user.id)
  assert.equal(unchanged.coach.branchId, ids.otherBranch)
  await assert.rejects(
    db.coachBranch.delete({ where: { coachId_branchId: { coachId: coach.id, branchId: ids.branch } } }),
  )
})

test('membership and schedule migrations preserve old lessons and fail closed for unconfirmed rosters', async () => {
  // Separate schema inside ONLY the disposable test DB; public and local data
  // are untouched. The entire database is discarded by the test runner.
  const sql = new PgClient({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  })
  const schema = 'upgrade_' + randomUUID().replaceAll('-', '')
  await sql.connect()
  try {
    await sql.query('CREATE SCHEMA "' + schema + '"')
    await sql.query('SET search_path TO "' + schema + '"')
    for (const migration of ['202610070001_foundation', '202610070002_integrity'])
      await sql.query(
        readFileSync(new URL('../../prisma/migrations/' + migration + '/migration.sql', import.meta.url), 'utf8'),
      )
    await sql.query(`
      INSERT INTO branches (id,name,address) VALUES ('old-branch','Old test branch','Fictional address');
      INSERT INTO users (id,name,username,branch_id,status,updated_at) VALUES ('old-user','Old coach','old-coach','old-branch','active',now());
      INSERT INTO coaches (id,user_id,branch_id,name) VALUES ('old-coach','old-user','old-branch','Old coach');
      INSERT INTO lessons (id,branch_id,coach_id,created_by_id,title,category,local_date,time_zone,starts_at,ends_at,updated_at)
      VALUES ('old-lesson','old-branch','old-coach','old-user','Old swimming','swimming','2026-10-07','Europe/Moscow','2026-10-07T14:00:00Z','2026-10-07T15:00:00Z',now());
    `)
    await sql.query(
      readFileSync(
        new URL('../../prisma/migrations/202610070003_coach_memberships/migration.sql', import.meta.url),
        'utf8',
      ),
    )
    const result = await sql.query(
      'SELECT l.branch_id, c.user_id, cb.coach_id FROM lessons l JOIN coaches c ON c.id=l.coach_id JOIN coach_branches cb ON cb.coach_id=l.coach_id AND cb.branch_id=l.branch_id',
    )
    assert.deepEqual(result.rows, [{ branch_id: 'old-branch', user_id: 'old-user', coach_id: 'old-coach' }])
    for (const migration of [
      '202610070004_auth_support',
      '202610070005_catalog_versions',
      '202610070006_schedule_recovery',
    ])
      await sql.query(
        readFileSync(new URL('../../prisma/migrations/' + migration + '/migration.sql', import.meta.url), 'utf8'),
      )
    assert.deepEqual((await sql.query('SELECT id,title,roster_confirmed FROM lessons')).rows, [
      { id: 'old-lesson', title: 'Old swimming', roster_confirmed: false },
    ])
    await sql.query(`
      INSERT INTO clients(id,branch_id,child_name,parent_name,updated_at) VALUES ('old-client','old-branch','Fictional child','Test',now());
      INSERT INTO mutation_requests(id,actor_id,request_key,action,fingerprint,result) VALUES ('old-request','old-user','old-document-request','uploadReceipt',repeat('a',64),'{}');
      INSERT INTO documents(id,client_id,branch_id,uploaded_by_id,request_id,storage_key,original_name,mime_type,size_bytes,sha256,created_at)
      VALUES ('old-document-1','old-client','old-branch','old-user','old-request',repeat('a',32),'Old.png','image/png',100,repeat('a',64),'2026-01-01'),
      ('old-document-2','old-client','old-branch','old-user','old-request',repeat('b',32),'New.png','image/png',100,repeat('b',64),'2026-02-01');
    `)
    await sql.query(
      readFileSync(new URL('../../prisma/migrations/202610080007_documents/migration.sql', import.meta.url), 'utf8'),
    )
    assert.deepEqual(
      (await sql.query('SELECT receipt_document_id,receipt_version FROM clients WHERE id=$1', ['old-client'])).rows,
      [{ receipt_document_id: 'old-document-2', receipt_version: 1 }],
    )
    assert.equal((await sql.query('SELECT count(*)::int AS count FROM documents')).rows[0].count, 2)
    assert.equal(
      (await sql.query('SELECT count(*)::int AS count FROM documents WHERE superseded_at IS NULL')).rows[0].count,
      1,
    )
    await sql.query(
      `INSERT INTO document_uploads(id,actor_id,client_id,request_key,fingerprint,storage_key) VALUES ('old-intent','old-user','old-client','old-file-intent',repeat('c',64),repeat('c',32));`,
    )
    await sql.query(
      readFileSync(
        new URL('../../prisma/migrations/202610080008_recovery_import/migration.sql', import.meta.url),
        'utf8',
      ),
    )
    assert.deepEqual((await sql.query('SELECT state,payload FROM document_uploads WHERE id=$1', ['old-intent'])).rows, [
      { state: 'pending', payload: null },
    ])
    await sql.query(
      readFileSync(
        new URL('../../prisma/migrations/202610080009_complete_recovery/migration.sql', import.meta.url),
        'utf8',
      ),
    )
    await assert.rejects(
      sql.query(
        "INSERT INTO mutation_drafts(id,actor_id,request_key,action,fingerprint,payload) VALUES ('bad-secret','old-user','secret-key','createCoach',repeat('a',64),'{\"password\":\"forbidden\"}')",
      ),
    )
  } finally {
    await sql.end()
  }
})
