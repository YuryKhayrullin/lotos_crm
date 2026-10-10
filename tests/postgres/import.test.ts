import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createPostgresClient } from '../../lib/server/postgres/client'
import { validateEnvironment } from '../../scripts/lib/environment.mjs'
import { verifyTestImport } from '../../lib/server/postgres/import-verification'
import {
  applyTestImport,
  importTargetId,
  testImportSummary,
  type TestImportPlan,
} from '../../lib/server/postgres/import'

validateEnvironment(process.env, 'test')
const db = createPostgresClient(process.env)
let actorId = ''
before(async () => {
  actorId = (
    await db.user.create({
      data: { username: 'import-test-owner', name: 'Fictional owner', role: 'admin', status: 'active' },
    })
  ).id
})
after(async () => {
  await db.$disconnect()
})
const record = (
  sheet: TestImportPlan['records'][number]['sheet'],
  sourceId: string,
  values: Record<string, string>,
  extra = {},
) => ({ sheet, sourceId, row: 2, values, dateIso: null, birthDateIso: null, time: null, ...extra })
function fixture(): TestImportPlan {
  const namespace = 'fixture-' + randomUUID(),
    sourceSha256 = createHash('sha256').update(namespace).digest('hex')
  return {
    version: 1,
    testOnly: true,
    namespace,
    sourceSha256,
    timeZone: 'Europe/Moscow',
    skipLegacyFinance: true,
    credentialPolicy: 'disabled-reset-required',
    coachBindings: { l: 'coach:k' },
    rosters: {},
    records: [
      record('Филиалы', 'b', { id: 'b', name: 'Fictional pool', address: 'Fictional' }),
      record('Users', 'u', { id: 'u', username: 'import-coach-' + randomUUID().slice(0, 8), role: '2', branchId: 'b' }),
      record('Тренеры', 'k', { id: 'k', name: 'Fictional coach', branchId: 'b', userId: 'u' }),
      record('Клиенты', 'c', {
        id: 'c',
        childName: 'Fictional pupil',
        parentName: 'Fictional parent',
        branchId: 'b',
        status: 'Активен',
        category: 'плавание',
        lessonsPerWeek: '1',
        remainingLessons: '3',
        totalLessons: '4',
        paidAmount: '5500',
        paymentBalance: '',
        attendanceHistory: JSON.stringify([
          { lessonId: 'l', date: '2026-10-05', status: 'attended', recordedBy: 'old-owner', requestId: 'old-request' },
        ]),
      }),
      record('Журнал занятий', 'j', {
        id: 'j',
        clientId: 'c',
        branchId: 'b',
        type: 'legacy_opening_balance',
        lessonsDelta: '3',
        totalLessonsDelta: '4',
        balanceBefore: '0',
        balanceAfter: '3',
        totalLessonsBefore: '0',
        totalLessonsAfter: '4',
      }),
      record(
        'Расписание',
        'l',
        {
          id: 'l',
          branchId: 'b',
          title: 'Fictional lesson',
          category: 'плавание',
          duration: '1 час',
          maxCapacity: '10',
          clientIds: 'c',
          isRecurring: 'false',
        },
        { dateIso: '2026-10-05', time: '17:00' },
      ),
    ],
  }
}
test('test import atomically retains credits, mappings, marks and source evidence without inventing payments', async () => {
  const plan = fixture(),
    beforeCount = await db.client.count()
  assert.equal(testImportSummary(plan).writes, 0)
  assert.equal(await db.client.count(), beforeCount)
  const result = await applyTestImport(db, plan, actorId, process.env)
  assert.equal(result.report.importedAttendance, 1)
  assert.equal((await verifyTestImport(db, plan, process.env)).success, true)
  const client = await db.client.findUniqueOrThrow({ where: { id: importTargetId(plan.namespace, 'Клиенты', 'c') } })
  assert.equal(client.remainingLessons, 3)
  assert.equal(client.paidAmountMinor, BigInt(0))
  assert.equal(await db.payment.count({ where: { clientId: client.id } }), 0)
  assert.equal(await db.attendance.count({ where: { clientId: client.id } }), 1)
  assert.equal(await db.importRecord.count({ where: { namespace: plan.namespace } }), 6)
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: importTargetId(plan.namespace, 'Users', 'u') } })).status,
    'disabled',
  )
  const repeat = await applyTestImport(db, plan, actorId, process.env)
  assert.equal(repeat.duplicate, true)
  assert.deepEqual(repeat.report, result.report)
  assert.equal(await db.client.count(), beforeCount + 1)
  await db.client.update({
    where: { id: client.id },
    data: { childName: 'Edited after import', version: { increment: 1 } },
  })
  await applyTestImport(db, plan, actorId, process.env)
  assert.equal((await verifyTestImport(db, plan, process.env)).success, true)
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: client.id } })).childName, 'Edited after import')
  await assert.rejects(applyTestImport(db, { ...plan, rosters: { l: [] } }, actorId, process.env), /Namespace/)
  await assert.rejects(
    applyTestImport(db, { ...plan, namespace: plan.namespace + '-other' }, actorId, process.env),
    /источник/,
  )
})
test('invalid links roll back catalogue, credits, marker, archive and namespace together', async () => {
  const plan = fixture()
  plan.coachBindings.l = 'coach:missing'
  const beforeCount = await db.branch.count()
  await assert.rejects(applyTestImport(db, plan, actorId, process.env))
  assert.equal(await db.branch.count(), beforeCount)
  assert.equal(await db.importBatch.count({ where: { namespace: plan.namespace } }), 0)
  assert.equal(await db.mutationRequest.count({ where: { requestKey: 'import:' + plan.namespace } }), 0)
})

test('source-credit discrepancy is rejected by the writer, not replaced by a made-up opening', async () => {
  const plan = fixture()
  plan.records.find((row) => row.sheet === 'Клиенты')!.values.remainingLessons = '2'
  await assert.rejects(applyTestImport(db, plan, actorId, process.env), /не подтверждены/)
  assert.equal(await db.importBatch.count({ where: { namespace: plan.namespace } }), 0)
})
test('unknown lessons stay quarantined, credentials are forbidden and production rejects before any SQL', async () => {
  const plan = fixture()
  plan.coachBindings = {}
  const result = await applyTestImport(db, plan, actorId, process.env)
  assert.equal(result.report.quarantinedLessons, 1)
  assert.equal(result.report.importedAttendance, 0)
  assert.equal(await db.lesson.count({ where: { id: importTargetId(plan.namespace, 'Расписание', 'l') } }), 0)
  await assert.rejects(applyTestImport(db, fixture(), actorId, { ...process.env, APP_ENV: 'production' }), /запрещён/)
  const secret = fixture()
  secret.records[1].values.password = 'forbidden-fixture'
  assert.throws(() => testImportSummary(secret), /credentials/)
  await assert.rejects(
    db.importBatch.update({ where: { namespace: plan.namespace }, data: { planSha256: '0'.repeat(64) } }),
  )
})
test('provided private test workbook can be repeated with exact counts and no password transfer', async (t) => {
  if (!existsSync('База данных.xlsx')) {
    t.skip('Private workbook is intentionally absent in CI')
    return
  }
  const buffer = execFileSync(
    'python3',
    ['-B', 'scripts/import-dry-run.py', 'База данных.xlsx', '--emit-test-plan', '--namespace', 'private-workbook-test'],
    { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 },
  )
  const plan = JSON.parse(buffer.toString('utf8')) as TestImportPlan
  assert.equal(
    plan.records.some((row) => 'password' in row.values),
    false,
  )
  const result = await applyTestImport(db, plan, actorId, process.env)
  assert.equal(result.report.counts['Клиенты'], 3)
  assert.equal(result.report.quarantinedLessons, 4)
  assert.equal(result.report.archivedHistoryMarks, 7)
  const verification = await verifyTestImport(db, plan, process.env)
  assert.equal(verification.success, true, JSON.stringify(verification.issues))
  assert.equal(verification.archivedRecords, 25)
  assert.equal(verification.archivedLessons, 4)
  assert.equal(verification.archivedMarks, 7)
  assert.deepEqual(
    verification.quantities.map((row) => [row.remainingLessons, row.totalLessons]),
    [
      [2, 4],
      [7, 8],
      [6, 8],
    ],
  )
  assert.equal((await applyTestImport(db, plan, actorId, process.env)).duplicate, true)
  assert.equal(
    await db.client.count({
      where: {
        id: {
          in: plan.records
            .filter((r) => r.sheet === 'Клиенты')
            .map((r) => importTargetId(plan.namespace, r.sheet, r.sourceId)),
        },
      },
    }),
    3,
  )
})

test('read-only reconciliation diagnoses discrepancies without silently repairing current cards', async () => {
  const plan = fixture()
  await assert.rejects(verifyTestImport(db, plan, process.env), /ещё не импортирован/)
  await applyTestImport(db, plan, actorId, process.env)
  const id = importTargetId(plan.namespace, 'Клиенты', 'c')
  await db.client.update({ where: { id }, data: { remainingLessons: 2 } })
  const before = await db.client.findUniqueOrThrow({ where: { id } })
  const result = await verifyTestImport(db, plan, process.env)
  assert.equal(result.success, false)
  assert.equal(result.writes, 0)
  assert.ok(result.issues.some((issue) => issue.code === 'CURRENT_ACCOUNTING_DISCREPANCY'))
  assert.deepEqual(await db.client.findUniqueOrThrow({ where: { id } }), before)
  assert.equal(JSON.stringify(result).includes('Fictional pupil'), false)
  const lessonId = importTargetId(plan.namespace, 'Расписание', 'l')
  const lesson = await db.lesson.findUniqueOrThrow({ where: { id: lessonId } })
  await db.lesson.update({
    where: { id: lessonId },
    data: {
      startsAt: new Date(lesson.startsAt.getTime() + 3600000),
      endsAt: new Date(lesson.endsAt.getTime() + 3600000),
    },
  })
  assert.ok(
    (await verifyTestImport(db, plan, process.env)).issues.some(
      (issue) => issue.code === 'INITIAL_OCCURRENCE_MISMATCH',
    ),
  )
  await db.lesson.update({ where: { id: lessonId }, data: { version: { increment: 1 } } })
  assert.equal(
    (await verifyTestImport(db, plan, process.env)).issues.some(
      (issue) => issue.code === 'INITIAL_OCCURRENCE_MISMATCH',
    ),
    false,
  )
  await assert.rejects(verifyTestImport(db, { ...plan, rosters: { l: [] } }, process.env), /не соответствует/)
  await assert.rejects(verifyTestImport(db, plan, { ...process.env, APP_ENV: 'production' }), /запрещена/)
})
