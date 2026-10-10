import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../.generated/prisma/client'
import { validateEnvironment } from '../../scripts/lib/environment.mjs'
import { bootstrapAdmin } from '../../lib/server/postgres/accounts'
import { createPostgresAuth } from '../../lib/server/postgres/auth'
import { createPostgresRouter } from '../../lib/server/postgres/http'

// Only the disposable database. Query text/parameters are NEVER recorded.
validateEnvironment(process.env, 'test')
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 5 }),
  log: [{ emit: 'event', level: 'query' }],
})
let queries = 0
db.$on('query', () => queries++)
const route = createPostgresRouter(db, createPostgresAuth(db, process.env), process.env)
const password = randomBytes(32).toString('base64url')
const branchId = randomUUID(),
  coachId = randomUUID(),
  lessonId = randomUUID()
const pupils = Array.from({ length: 5000 }, () => randomUUID())
const date = '2026-10-09'
let cookie = '',
  actorId = '',
  markVersion = 0
const results: Record<string, unknown>[] = []
async function seedHistory(requestId: string) {
  // Long, structurally valid ABSENCE history, outside timing. No fake payments.
  const historical = await db.lesson.findMany({ where: { id: { not: lessonId } }, take: 500, select: { id: true } })
  const historyRows = historical.map((lesson) => ({
    lessonId: lesson.id,
    enrollmentId: randomUUID(),
    attendanceId: randomUUID(),
    eventId: randomUUID(),
  }))
  await db.lessonEnrollment.createMany({
    data: historyRows.map((row) => ({ id: row.enrollmentId, lessonId: row.lessonId, clientId: pupils[0], branchId })),
  })
  await db.attendance.createMany({
    data: historyRows.map((row) => ({
      id: row.attendanceId,
      enrollmentId: row.enrollmentId,
      lessonId: row.lessonId,
      clientId: pupils[0],
      branchId,
      status: 'absent' as const,
      version: 1,
    })),
  })
  await db.attendanceEvent.createMany({
    data: historyRows.map((row) => ({
      id: row.eventId,
      attendanceId: row.attendanceId,
      clientId: pupils[0],
      branchId,
      actorId,
      requestId,
      status: 'absent' as const,
      previousStatus: null,
      version: 1,
      lessonSnapshot: {
        id: row.lessonId,
        date,
        time: '17:00',
        timeZone: 'Europe/Moscow',
        title: 'Fictional historical swimming',
        coachId,
      },
      reason: 'Fictional historical absence',
    })),
  })
  await db.lessonLedgerEntry.createMany({
    data: historyRows.map((row, index) => ({
      clientId: pupils[0],
      branchId,
      actorId,
      requestId,
      attendanceEventId: row.eventId,
      type: 'attendance' as const,
      sequence: index + 2,
      lessonsDelta: 0,
      totalLessonsDelta: 0,
      balanceBefore: 100,
      balanceAfter: 100,
      totalBefore: 100,
      totalAfter: 100,
      reason: 'Fictional historical absence',
    })),
  })
  await db.client.update({ where: { id: pupils[0] }, data: { ledgerVersion: 501 } })
}
async function call(action: string, payload: unknown) {
  const response = await route(
    new Request(process.env.APP_URL + '/api/crm', {
      method: 'POST',
      headers: { origin: process.env.APP_URL!, 'content-type': 'application/json', cookie },
      body: JSON.stringify({ action, payload }),
    }),
    ['crm'],
  )
  assert.equal(response.status, 200, 'successful benchmark action: ' + action)
  return response.json()
}
before(async () => {
  actorId = (await bootstrapAdmin(db, { username: 'benchmark-admin', name: 'Fictional benchmark owner', password })).id
  await db.branch.create({ data: { id: branchId, name: 'Fictional benchmark branch', address: 'Test only' } })
  await db.coach.create({
    data: { id: coachId, branchId, name: 'Fictional benchmark coach', memberships: { create: { branchId } } },
  })
  for (let offset = 0; offset < pupils.length; offset += 500)
    await db.client.createMany({
      data: pupils.slice(offset, offset + 500).map((id, i) => ({
        id,
        branchId,
        childName: 'Fictional pupil ' + (offset + i),
        parentName: 'Fictional parent',
        totalLessons: 100,
        remainingLessons: 100,
        ledgerVersion: 1,
      })),
    })
  const request = await db.mutationRequest.create({
    data: { actorId, requestKey: randomUUID(), action: 'benchmark-fixture', fingerprint: 'a'.repeat(64), result: {} },
  })
  for (let offset = 0; offset < pupils.length; offset += 500)
    await db.lessonLedgerEntry.createMany({
      data: pupils.slice(offset, offset + 500).map((clientId) => ({
        clientId,
        branchId,
        actorId,
        requestId: request.id,
        type: 'opening_balance' as const,
        sequence: 1,
        lessonsDelta: 100,
        totalLessonsDelta: 100,
        balanceBefore: 0,
        balanceAfter: 100,
        totalBefore: 0,
        totalAfter: 100,
        reason: 'Fictional benchmark opening',
      })),
    })
  await db.lesson.createMany({
    data: Array.from({ length: 1000 }, (_, i) => ({
      id: i === 0 ? lessonId : randomUUID(),
      branchId,
      coachId,
      createdById: actorId,
      title: 'Fictional swimming',
      category: 'swimming' as const,
      localDate: new Date(date),
      timeZone: 'Europe/Moscow',
      startsAt: new Date(date + 'T14:00:00Z'),
      endsAt: new Date(date + 'T15:00:00Z'),
      capacity: 100,
      rosterConfirmed: true,
    })),
  })
  await db.lessonEnrollment.createMany({
    data: pupils.slice(0, 100).map((clientId) => ({ lessonId, clientId, branchId })),
  })
  await seedHistory(request.id)
  const response = await route(
    new Request(process.env.APP_URL + '/api/auth/login', {
      method: 'POST',
      headers: { origin: process.env.APP_URL!, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'benchmark-admin', password }),
    }),
    ['auth', 'login'],
  )
  assert.equal(response.status, 200)
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
})
after(async () => {
  mkdirSync('.artifacts', { recursive: true })
  writeFileSync(
    '.artifacts/performance-latest.json',
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        environment: 'disposable-test',
        node: process.versions.node,
        transport: 'in-process API router + real PostgreSQL TCP (not public HTTP/browser)',
        fixture: { clients: 5000, lessons: 1000, roster: 100, historicalAbsences: 500 },
        results,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  await db.$disconnect()
})
async function measure(name: string, fn: () => Promise<unknown>, limitQueries?: number) {
  const timings: number[] = [],
    counts: number[] = [],
    bytes: number[] = []
  await fn() // Warm-up excluded; write scenarios deliberately get fresh keys.
  for (let index = 0; index < 12; index++) {
    const initial = queries,
      started = performance.now()
    const value = await fn()
    timings.push(performance.now() - started)
    counts.push(queries - initial)
    bytes.push(Buffer.byteLength(JSON.stringify(value)))
  }
  timings.sort((a, b) => a - b)
  const report = {
    name,
    samples: timings.length,
    p50Ms: +timings[5].toFixed(2),
    p95Ms: +timings[11].toFixed(2),
    maxQueries: Math.max(...counts),
    maxResponseBytes: Math.max(...bytes),
  }
  results.push(report)
  console.log('BENCHMARK ' + JSON.stringify(report))
  if (limitQueries) assert.ok(report.maxQueries <= limitQueries, 'bounded SQL reads: ' + name)
  // Gross regression guard, NOT a promise about production SLO or VPS latency.
  assert.ok(report.p95Ms < 10000, 'benchmark completed within broad test guard')
}
test('schedule on a larger fictional dataset has bounded query count', async () => {
  await measure('schedule-1000', () => call('getSchedule', { from: date, to: date, branchId }), 12)
})
test('one-hundred-person roster does not read each card separately', async () => {
  await measure('roster-100', () => call('getLessonRoster', { lessonId, date }), 15)
})
test('atomic attendance is measured including locks, journal and durable requests', async () => {
  await measure(
    'attendance-20',
    async () => {
      const result = await call('recordBulkAttendance', {
        requestId: randomUUID(),
        expectedLessonVersion: 1,
        attendance: pupils
          .slice(0, 20)
          .map((clientId) => ({ clientId, lessonId, date, status: 'absent', expectedVersion: markVersion })),
      })
      markVersion++
      return result
    },
    125,
  )
})
test('history and audit remain bounded in SQL round trips', async () => {
  await measure('history-with-audit', () => call('getClientHistory', { clientId: pupils[0], includeAudit: true }), 18)
})
