import 'server-only'
import { z } from 'zod'
import type { Prisma, PrismaClient } from '../../../.generated/prisma/client'
import { type Actor, lockActor } from './access'
import { authDigest } from './accounts'
import { requestKeySchema } from './auth-input'
import { dateOnlySchema } from './validation'
import { domainMutation } from './mutations'
import { lessonDto, requireOccurrence } from './schedule'
import { PostgresApiError } from './errors'
import { accountingState, requireReconciled } from './accounting-state'

const id = z.string().min(1).max(100)
const item = z
  .object({
    clientId: id,
    lessonId: id,
    date: dateOnlySchema,
    status: z.enum(['attended', 'absent']),
    expectedVersion: z.number().int().nonnegative(),
    isWalkin: z.literal(false).default(false),
  })
  .strict()
const bulk = z
  .object({
    requestId: requestKeySchema,
    expectedLessonVersion: z.number().int().positive(),
    reason: z.string().trim().max(500).default(''),
    attendance: z.array(item).min(1).max(100),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.attendance.map((mark) => mark.clientId)).size === value.attendance.length &&
      value.attendance.every(
        (mark) => mark.lessonId === value.attendance[0].lessonId && mark.date === value.attendance[0].date,
      ),
    'Один пакет должен содержать уникальных учеников одного экземпляра',
  )
const canonicalInput = (input: unknown) => {
  const data = bulk.parse(input)
  data.attendance.sort((a, b) => a.clientId.localeCompare(b.clientId))
  return data
}
const fingerprint = (secret: string, payload: unknown) =>
  authDigest(secret, 'domain-mutation', { action: 'recordBulkAttendance', payload })
const requestWhere = (actor: Actor, requestKey: string) => ({ actorId_requestKey: { actorId: actor.id, requestKey } })

export async function lessonRoster(db: PrismaClient, actor: Actor, input: unknown) {
  const data = z.object({ lessonId: id, date: dateOnlySchema }).strict().parse(input)
  return db.$transaction(
    async (tx) => {
      const lesson = await requireOccurrence(tx, actor, data.lessonId, data.date)
      if (!lesson.rosterConfirmed)
        throw new PostgresApiError(
          409,
          'CONFLICT',
          'Состав исторического занятия не подтверждён. Отметка всех клиентов филиала запрещена.',
        )
      const rows = await tx.lessonEnrollment.findMany({
        where: { lessonId: lesson.id, OR: [{ status: 'active' }, { attendance: { isNot: null } }] },
        include: { client: true, attendance: true },
        orderBy: { clientId: 'asc' },
      })
      const draft = await tx.attendanceDraft.findFirst({
        where: { actorId: actor.id, lessonId: lesson.id },
        orderBy: { createdAt: 'asc' },
      })
      const pending = draft ? canonicalInput(draft.payload) : null
      return {
        lessonId: lesson.id,
        date: data.date,
        lessonVersion: lesson.version,
        cancelled: lesson.status === 'cancelled',
        clients: rows.map((row) => ({
          id: row.clientId,
          childName: row.client.childName,
          parentName: actor.role === 'admin' ? row.client.parentName : '',
          category: row.client.category === 'swimming' ? 'плавание' : 'синхронное плавание',
          status: { active: 'Активен', paused: 'Пауза', archived: 'Архив' }[row.client.status],
          remainingLessons: row.client.remainingLessons,
          mark: row.attendance?.status || null,
          version: row.attendance?.version || 0,
          canMark:
            lesson.status !== 'cancelled' &&
            row.client.status !== 'archived' &&
            (row.status === 'active' || Boolean(row.attendance)),
        })),
        pendingAttempt: pending
          ? {
              requestId: pending.requestId,
              lessonId: lesson.id,
              date: data.date,
              expectedLessonVersion: pending.expectedLessonVersion,
              reason: pending.reason,
              attendanceList: pending.attendance.map((mark) => ({
                clientId: mark.clientId,
                status: mark.status,
                expectedVersion: mark.expectedVersion,
              })),
            }
          : null,
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}

async function validateMarks(tx: Prisma.TransactionClient, actor: Actor, data: ReturnType<typeof canonicalInput>) {
  const first = data.attendance[0]
  const lesson = await requireOccurrence(tx, actor, first.lessonId, first.date)
  if (lesson.status === 'cancelled' || !lesson.rosterConfirmed)
    throw new PostgresApiError(409, 'CONFLICT', 'Занятие отменено или его состав не подтверждён')
  if (lesson.version !== data.expectedLessonVersion)
    throw new PostgresApiError(409, 'CONFLICT', 'Состав или контекст занятия изменился. Обновите список.')
  const rows = await tx.lessonEnrollment.findMany({
    where: { lessonId: lesson.id, clientId: { in: data.attendance.map((mark) => mark.clientId) } },
    include: { client: true, attendance: true },
  })
  if (rows.length !== data.attendance.length)
    throw new PostgresApiError(403, 'FORBIDDEN', 'Клиент не назначен этому экземпляру занятия')
  for (const mark of data.attendance) {
    const entry = rows.find((row) => row.clientId === mark.clientId)!
    if (entry.client.branchId !== lesson.branchId || (entry.status !== 'active' && !entry.attendance))
      throw new PostgresApiError(403, 'FORBIDDEN', 'Нет подтверждённого назначения ученика')
    if (entry.client.status === 'archived')
      throw new PostgresApiError(
        409,
        'CONFLICT',
        'Клиент в архиве. История сохранена; перед исправлением согласуйте восстановление карточки.',
      )
    if ((entry.attendance?.version || 0) !== mark.expectedVersion)
      throw new PostgresApiError(409, 'CONFLICT', 'Отметка изменилась на другом устройстве. Обновите список.')
    const delta = (entry.attendance?.status === 'attended' ? 1 : 0) - (mark.status === 'attended' ? 1 : 0)
    if (entry.client.remainingLessons + delta < 0)
      throw new PostgresApiError(409, 'CONFLICT', 'Недостаточно оплаченных занятий')
  }
  return { lesson, rows }
}

export async function prepareAttendance(db: PrismaClient, actor: Actor, input: unknown, secret: string) {
  const data = canonicalInput(input),
    hash = fingerprint(secret, data)
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id + ':' + data.requestId},0))`
    const canonical = await lockActor(tx, actor)
    await requireOccurrence(tx, canonical, data.attendance[0].lessonId, data.attendance[0].date)
    const marker = await tx.mutationRequest.findUnique({ where: requestWhere(canonical, data.requestId) })
    const draft = await tx.attendanceDraft.findUnique({ where: requestWhere(canonical, data.requestId) })
    if (
      (marker && (marker.action !== 'recordBulkAttendance' || marker.fingerprint !== hash)) ||
      (draft && draft.fingerprint !== hash)
    )
      throw new PostgresApiError(409, 'CONFLICT', 'Этот requestId уже использован с другими данными')
    if (!marker && !draft) await validateMarks(tx, canonical, data)
    if (!draft) {
      if ((await tx.attendanceDraft.count({ where: { actorId: canonical.id } })) >= 100)
        throw new PostgresApiError(409, 'CONFLICT', 'Сначала подтвердите сохранённые попытки посещаемости')
      await tx.attendanceDraft.create({
        data: {
          actorId: canonical.id,
          lessonId: data.attendance[0].lessonId,
          requestKey: data.requestId,
          fingerprint: hash,
          payload: data as Prisma.InputJsonValue,
        },
      })
    }
    return { success: true }
  })
}

export async function recordAttendance(db: PrismaClient, actor: Actor, input: unknown, secret: string) {
  const data = canonicalInput(input)
  // Explicit prepare also supports direct API callers, not only the UI. Draft
  // survives a lost reply after commit until the caller acknowledges success.
  await prepareAttendance(db, actor, data, secret)
  try {
    return await domainMutation(
      db,
      actor,
      'recordBulkAttendance',
      data.requestId,
      data,
      secret,
      async (tx, canonical, requestId) => {
        const first = data.attendance[0]
        await tx.$queryRaw`SELECT id FROM lessons WHERE id=${first.lessonId} FOR UPDATE`
        // Lock clients in stable ID order across different lessons. This protects
        // the last credit without serializing every attendance request globally.
        for (const mark of data.attendance)
          await tx.$queryRaw`SELECT id FROM clients WHERE id=${mark.clientId} FOR UPDATE`
        const { lesson, rows } = await validateMarks(tx, canonical, data)
        for (const row of rows) requireReconciled(await accountingState(tx, row.client, secret))
        const results = []
        for (const mark of data.attendance) {
          const row = rows.find((entry) => entry.clientId === mark.clientId)!,
            client = row.client
          const before = row.attendance?.status || null,
            delta = (before === 'attended' ? 1 : 0) - (mark.status === 'attended' ? 1 : 0),
            version = mark.expectedVersion + 1
          const attendance = await tx.attendance.upsert({
            where: { enrollmentId: row.id },
            create: {
              enrollmentId: row.id,
              lessonId: lesson.id,
              clientId: client.id,
              branchId: lesson.branchId,
              status: mark.status,
              version,
            },
            update: { status: mark.status, version },
          })
          const event = await tx.attendanceEvent.create({
            data: {
              attendanceId: attendance.id,
              clientId: client.id,
              branchId: lesson.branchId,
              requestId,
              actorId: canonical.id,
              previousStatus: before,
              status: mark.status,
              version,
              reason: data.reason || null,
              // Historical context is never a permission snapshot.
              lessonSnapshot: {
                id: lesson.id,
                date: first.date,
                title: lesson.title,
                coachId: lesson.coachId,
                coachName: lesson.coach.name,
                time: lessonDto(lesson, canonical).time,
                timeZone: lesson.timeZone,
                pool: lesson.location || '',
              },
            },
          })
          await tx.lessonLedgerEntry.create({
            data: {
              clientId: client.id,
              branchId: lesson.branchId,
              requestId,
              actorId: canonical.id,
              attendanceEventId: event.id,
              type: before ? 'attendance_correction' : 'attendance',
              lessonsDelta: delta,
              totalLessonsDelta: 0,
              sequence: client.ledgerVersion + 1,
              balanceBefore: client.remainingLessons,
              balanceAfter: client.remainingLessons + delta,
              totalBefore: client.totalLessons,
              totalAfter: client.totalLessons,
              reason: data.reason || (before ? 'Исправление отметки посещения' : 'Подтверждение посещения'),
            },
          })
          const updated = await tx.client.update({
            where: { id: client.id },
            data: {
              remainingLessons: { increment: delta },
              ledgerVersion: { increment: 1 },
              version: { increment: 1 },
            },
          })
          results.push({
            clientId: client.id,
            success: true,
            client: {
              remainingLessons: updated.remainingLessons,
              totalLessons: updated.totalLessons,
              status: { active: 'Активен', paused: 'Пауза', archived: 'Архив' }[updated.status],
            },
          })
        }
        await tx.auditEvent.create({
          data: {
            actorId: canonical.id,
            requestId,
            action: 'recordBulkAttendance',
            entityType: 'lesson',
            entityId: lesson.id,
            branchId: lesson.branchId,
            changedFields: ['attendance', 'history', 'lessonLedger'],
            reason: data.reason || null,
          },
        })
        return { status: 'success', success: true, results }
      },
      async (tx, _result, canonical) => {
        await requireOccurrence(tx, canonical, data.attendance[0].lessonId, data.attendance[0].date)
        const clients = await tx.client.findMany({
          where: { id: { in: data.attendance.map((mark) => mark.clientId) } },
        })
        if (clients.length !== data.attendance.length)
          throw new PostgresApiError(409, 'CONFLICT', 'Подтверждение требует сверки')
        return {
          status: 'success',
          success: true,
          results: clients.map((client) => ({
            clientId: client.id,
            success: true,
            duplicate: true,
            client: {
              remainingLessons: client.remainingLessons,
              totalLessons: client.totalLessons,
              status: { active: 'Активен', paused: 'Пауза', archived: 'Архив' }[client.status],
            },
          })),
        }
      },
      { timeout: 20_000 },
    )
  } catch (error) {
    if (error instanceof PostgresApiError && [400, 403, 404, 409, 422].includes(error.status)) {
      // This transaction has rolled back. Never discard an unknown outcome or
      // a confirmed marker merely because a subsequent retry was rejected.
      const marker = await db.mutationRequest.findUnique({ where: requestWhere(actor, data.requestId) })
      if (!marker) await db.attendanceDraft.deleteMany({ where: { actorId: actor.id, requestKey: data.requestId } })
    }
    throw error
  }
}
export async function acknowledgeAttendance(db: PrismaClient, actor: Actor, input: unknown) {
  const data = z.object({ requestId: requestKeySchema }).strict().parse(input)
  return db.$transaction(async (tx) => {
    const canonical = await lockActor(tx, actor)
    const draft = await tx.attendanceDraft.findUnique({ where: requestWhere(canonical, data.requestId) })
    if (!draft) return { success: true }
    const payload = canonicalInput(draft.payload)
    await requireOccurrence(tx, canonical, draft.lessonId, payload.attendance[0].date)
    const marker = await tx.mutationRequest.findUnique({ where: requestWhere(canonical, data.requestId) })
    if (!marker || marker.action !== 'recordBulkAttendance' || marker.fingerprint !== draft.fingerprint)
      throw new PostgresApiError(409, 'CONFLICT', 'Неподтверждённую попытку нельзя удалять')
    await tx.attendanceDraft.deleteMany({ where: { actorId: canonical.id, requestKey: data.requestId } })
    return { success: true }
  })
}
export function singleAttendancePayload(input: unknown) {
  const data = item
    .extend({
      requestId: requestKeySchema,
      expectedLessonVersion: z.number().int().positive(),
      reason: z.string().trim().max(500).optional(),
    })
    .strict()
    .parse(input)
  const { requestId, expectedLessonVersion, reason, ...mark } = data
  return { requestId, expectedLessonVersion, reason, attendance: [mark] }
}
