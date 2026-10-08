import 'server-only'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Lesson, Prisma, PrismaClient } from '../../../.generated/prisma/client'
import { branchScope, requireAdmin, type Actor } from './access'
import { categoryValue, requireBranch } from './catalog'
import { requestKeySchema } from './auth-input'
import { dateOnlySchema } from './validation'
import { domainMutation, mutationEntity } from './mutations'
import { PostgresApiError } from './errors'

const id = z.string().trim().min(1).max(100)
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const category = z.enum(['плавание', 'синхронное плавание'])
const pupils = z
  .array(id)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'Клиенты не должны повторяться')
const editable = {
  title: z.string().trim().min(1).max(150).optional(),
  pool: z.string().trim().max(150).optional(),
  date: dateOnlySchema.optional(),
  time: time.optional(),
  durationMinutes: z.number().int().min(1).max(1440).optional(),
  maxCapacity: z.number().int().min(1).max(100).optional(),
  coachId: id.optional(),
}
const create = z
  .object({
    requestId: requestKeySchema,
    branchId: id.optional(),
    coachId: id.optional(),
    coachUserId: id.optional(),
    coachName: z.string().max(150).optional(),
    title: z.string().trim().min(1).max(150),
    category: category.default('плавание'),
    date: dateOnlySchema,
    time,
    dayOfWeek: z.string().max(10).optional(),
    pool: z.string().trim().max(150).default(''),
    duration: z.string().max(40).optional(),
    durationMinutes: z.number().int().min(1).max(1440).default(60),
    maxCapacity: z.number().int().min(1).max(100).default(10),
    clientIds: pupils.default([]),
    isRecurring: z.boolean().default(false),
    endDate: dateOnlySchema.optional(),
  })
  .strict()
const mutation = z.object({ id, requestId: requestKeySchema, expectedVersion: z.number().int().positive() }).strict()
export const scheduleSchemas = {
  createLesson: create,
  createLessonWithClients: create,
  updateLesson: mutation.extend(editable),
  cancelLesson: mutation.extend({ reason: z.string().trim().min(1).max(500) }),
  deleteLesson: mutation,
  assignClientLesson: z
    .object({ requestId: requestKeySchema, lessonId: id, clientId: id, expectedVersion: z.number().int().positive() })
    .strict(),
} as const
export type ScheduleAction = keyof typeof scheduleSchemas
export type DisplayLesson = Lesson & {
  coach: { name: string; userId: string | null }
  _count?: { enrollments: number }
}
export function lessonDto(lesson: DisplayLesson, actor: Actor) {
  const owns = actor.role === 'admin' || (lesson.branchId === actor.branchId && lesson.coach.userId === actor.id)
  return {
    id: lesson.id,
    branchId: lesson.branchId,
    coachId: lesson.coachId,
    coachName: lesson.coach.name,
    title: lesson.title,
    category: lesson.category === 'swimming' ? 'плавание' : 'синхронное плавание',
    date: lesson.localDate.toISOString().slice(0, 10),
    time: new Intl.DateTimeFormat('en-GB', {
      timeZone: lesson.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(lesson.startsAt),
    timeZone: lesson.timeZone,
    startsAt: lesson.startsAt.toISOString(),
    endsAt: lesson.endsAt.toISOString(),
    dayOfWeek: ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][lesson.localDate.getUTCDay()],
    pool: lesson.location || '',
    duration: `${Math.round((lesson.endsAt.getTime() - lesson.startsAt.getTime()) / 60000)} мин`,
    maxCapacity: lesson.capacity,
    count: `${lesson._count?.enrollments || 0} / ${lesson.capacity}`,
    isRecurring: false,
    seriesId: lesson.seriesId || '',
    version: lesson.version,
    status: lesson.status,
    canEdit: owns && lesson.status !== 'cancelled',
    canCancel: owns && lesson.status !== 'cancelled',
    canDelete: actor.role === 'admin',
  }
}
export function requireLessonScope(lesson: { branchId: string }, actor: Actor) {
  if (actor.role === 'coach' && lesson.branchId !== actor.branchId)
    throw new PostgresApiError(403, 'FORBIDDEN', 'Доступ к чужому филиалу запрещён')
}
export function requireLessonOwner(lesson: { branchId: string; coach: { userId: string | null } }, actor: Actor) {
  requireLessonScope(lesson, actor)
  if (actor.role === 'coach' && lesson.coach.userId !== actor.id)
    throw new PostgresApiError(403, 'FORBIDDEN', 'Изменять и отменять можно только назначенные вам занятия')
}
export async function requireOccurrence(
  tx: Prisma.TransactionClient | PrismaClient,
  actor: Actor,
  lessonId: string,
  date: string,
) {
  const lesson = await tx.lesson.findUnique({
    where: { id: lessonId },
    include: { coach: { select: { name: true, userId: true } } },
  })
  if (!lesson) throw new PostgresApiError(404, 'NOT_FOUND', 'Занятие не найдено')
  requireLessonScope(lesson, actor)
  if (lesson.localDate.toISOString().slice(0, 10) !== date)
    throw new PostgresApiError(409, 'CONFLICT', 'Дата не соответствует экземпляру занятия')
  return lesson
}
export async function instant(tx: Prisma.TransactionClient, date: string, clock: string, zone: string) {
  const rows = await tx.$queryRaw<
    Array<{ value: Date }>
  >`SELECT (${date}::date + ${clock}::time) AT TIME ZONE ${zone} AS value`
  const value = rows[0].value
  const label = (candidate: Date) =>
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(candidate)
  const expected = date + ' ' + clock
  if (
    label(value) !== expected ||
    [-120, -90, -60, -30, 30, 60, 90, 120].some(
      (offset) => label(new Date(value.getTime() + offset * 60000)) === expected,
    )
  )
    throw new PostgresApiError(
      400,
      'VALIDATION',
      'Местное время неоднозначно или не существует из-за перехода часового пояса',
    )
  return value
}
async function resolveCoach(
  tx: Prisma.TransactionClient,
  actor: Actor,
  branchId: string,
  coachId?: string,
  coachUserId?: string,
) {
  if (actor.role === 'coach') {
    if (coachUserId && coachUserId !== actor.id)
      throw new PostgresApiError(403, 'FORBIDDEN', 'Нельзя назначить другого тренера')
    coachUserId = actor.id
  }
  if (coachUserId) {
    const user = await tx.user.findUnique({ where: { id: coachUserId }, include: { coach: true } })
    if (!user || user.role !== 'coach' || user.status !== 'active' || user.branchId !== branchId)
      throw new PostgresApiError(403, 'FORBIDDEN', 'Тренеру не назначен действующий доступ в филиал')
    const profile =
      user.coach ||
      (await tx.coach.create({
        data: { name: user.name, branchId, userId: user.id, memberships: { create: { branchId } } },
      }))
    if (profile.archivedAt || profile.branchId !== branchId || (coachId && coachId !== profile.id))
      throw new PostgresApiError(403, 'FORBIDDEN', 'Профиль не соответствует назначенному тренеру и филиалу')
    return profile
  }
  if (!coachId) throw new PostgresApiError(400, 'VALIDATION', 'Передайте устойчивый идентификатор тренера, а не имя')
  const profile = await tx.coach.findUnique({ where: { id: coachId } })
  if (!profile || profile.archivedAt || profile.branchId !== branchId)
    throw new PostgresApiError(403, 'FORBIDDEN', 'Карточка тренера не относится к филиалу')
  await tx.coachBranch.upsert({
    where: { coachId_branchId: { coachId: profile.id, branchId } },
    create: { coachId: profile.id, branchId },
    update: {},
  })
  return profile
}
export async function mutateSchedule(
  db: PrismaClient,
  actor: Actor,
  action: ScheduleAction,
  input: unknown,
  secret: string,
) {
  const parsed = scheduleSchemas[action].parse(input)
  const data = parsed as Record<string, unknown> & { requestId: string; id?: string; expectedVersion?: number }
  return domainMutation<unknown>(
    db,
    actor,
    action,
    data.requestId,
    parsed,
    secret,
    async (tx, canonical, requestId) => {
      const audit = (entityId: string, branchId: string, changedFields: string[]) =>
        tx.auditEvent.create({
          data: { actorId: canonical.id, requestId, action, entityType: 'lesson', entityId, branchId, changedFields },
        })
      if (action === 'createLesson' || action === 'createLessonWithClients') {
        const payload = create.parse(parsed)
        const branchId = canonical.role === 'coach' ? canonical.branchId! : payload.branchId
        if (!branchId) throw new PostgresApiError(400, 'VALIDATION', 'Выберите филиал')
        if (canonical.role === 'coach' && payload.branchId && payload.branchId !== branchId)
          throw new PostgresApiError(403, 'FORBIDDEN', 'Нельзя создать занятие чужого филиала')
        const branch = await requireBranch(tx, branchId)
        const coach = await resolveCoach(tx, canonical, branchId, payload.coachId, payload.coachUserId)
        if (payload.clientIds.length > payload.maxCapacity)
          throw new PostgresApiError(400, 'VALIDATION', 'Состав превышает вместимость')
        const clients = await tx.client.findMany({ where: { id: { in: payload.clientIds } } })
        if (
          clients.length !== payload.clientIds.length ||
          clients.some(
            (client) =>
              client.branchId !== branchId ||
              client.status !== 'active' ||
              client.category !== categoryValue(payload.category),
          )
        )
          throw new PostgresApiError(403, 'FORBIDDEN', 'Выбраны недопустимые ученики филиала или секции')
        const startsAt = await instant(tx, payload.date, payload.time, branch.timeZone)
        if (startsAt <= new Date()) throw new PostgresApiError(400, 'VALIDATION', 'Новое занятие должно быть в будущем')
        const dates = [payload.date]
        if (payload.isRecurring) {
          if (!payload.endDate || payload.endDate < payload.date)
            throw new PostgresApiError(400, 'VALIDATION', 'Для повторений укажите конечную дату')
          for (let offset = 7; ; offset += 7) {
            const next = new Date(new Date(payload.date + 'T00:00:00Z').getTime() + offset * 86400000)
              .toISOString()
              .slice(0, 10)
            if (next > payload.endDate) break
            dates.push(next)
            if (dates.length > 52)
              throw new PostgresApiError(
                400,
                'VALIDATION',
                'За одно создание допускается до 52 еженедельных экземпляров',
              )
          }
        } else if (payload.endDate)
          throw new PostgresApiError(400, 'VALIDATION', 'Конечная дата допустима только для повторений')
        const series = payload.isRecurring
          ? await tx.lessonSeries.create({
              data: {
                branchId,
                coachId: coach.id,
                title: payload.title,
                location: payload.pool,
                category: categoryValue(payload.category),
                startDate: new Date(payload.date + 'T00:00:00Z'),
                endDate: new Date(payload.endDate! + 'T00:00:00Z'),
                localTime: new Date('1970-01-01T' + payload.time + ':00Z'),
                timeZone: branch.timeZone,
                weekdays: [new Date(payload.date + 'T00:00:00Z').getUTCDay()],
                durationMinutes: payload.durationMinutes,
              },
            })
          : null
        if (series && payload.clientIds.length)
          await tx.seriesEnrollment.createMany({
            data: payload.clientIds.map((clientId) => ({
              seriesId: series.id,
              clientId,
              branchId,
              effectiveFrom: series.startDate,
            })),
          })
        const lessons = []
        for (const date of dates) {
          const start = date === payload.date ? startsAt : await instant(tx, date, payload.time, branch.timeZone)
          lessons.push({
            rosterConfirmed: true,
            id: randomUUID(),
            branchId,
            coachId: coach.id,
            seriesId: series?.id,
            createdById: canonical.id,
            title: payload.title,
            location: payload.pool,
            category: categoryValue(payload.category),
            localDate: new Date(date + 'T00:00:00Z'),
            timeZone: branch.timeZone,
            startsAt: start,
            endsAt: new Date(start.getTime() + payload.durationMinutes * 60000),
            capacity: payload.maxCapacity,
          })
        }
        await tx.lesson.createMany({ data: lessons })
        if (payload.clientIds.length)
          await tx.lessonEnrollment.createMany({
            data: lessons.flatMap((lesson) =>
              payload.clientIds.map((clientId) => ({ lessonId: lesson.id, clientId, branchId })),
            ),
          })
        await audit(lessons[0].id, branchId, ['created', 'coachId', 'roster', ...(series ? ['seriesId'] : [])])
        const result = await tx.lesson.findUniqueOrThrow({
          where: { id: lessons[0].id },
          include: { coach: { select: { name: true, userId: true } }, _count: { select: { enrollments: true } } },
        })
        return {
          ...lessonDto(result, canonical),
          clientsAssigned: payload.clientIds.length,
          occurrencesCreated: lessons.length,
        }
      }
      const lessonId = action === 'assignClientLesson' ? String(data.lessonId) : data.id!
      await tx.$queryRaw`SELECT id FROM lessons WHERE id = ${lessonId} FOR UPDATE`
      const lesson = await tx.lesson.findUnique({
        where: { id: lessonId },
        include: { coach: { select: { name: true, userId: true } }, enrollments: { include: { attendance: true } } },
      })
      if (!lesson) throw new PostgresApiError(404, 'NOT_FOUND', 'Занятие не найдено')
      requireLessonScope(lesson, canonical)
      if (action === 'assignClientLesson' || action === 'deleteLesson') requireAdmin(canonical)
      else requireLessonOwner(lesson, canonical)
      if (lesson.version !== data.expectedVersion)
        throw new PostgresApiError(409, 'CONFLICT', 'Занятие изменилось. Обновите расписание.')
      const marked = lesson.enrollments.some((entry) => entry.attendance)
      if (action === 'cancelLesson') {
        if (marked)
          throw new PostgresApiError(409, 'CONFLICT', 'Отмена занятия с отметками запрещена, включая отсутствие')
        if (lesson.status === 'cancelled') throw new PostgresApiError(409, 'CONFLICT', 'Занятие уже отменено')
        await tx.lesson.update({
          where: { id: lesson.id },
          data: {
            status: 'cancelled',
            cancelledAt: new Date(),
            cancellationReason: String(data.reason),
            version: { increment: 1 },
          },
        })
        await audit(lesson.id, lesson.branchId, ['status', 'cancellationReason'])
      } else if (action === 'deleteLesson') {
        if (marked || lesson.startsAt <= new Date())
          throw new PostgresApiError(409, 'CONFLICT', 'Историческое или отмеченное занятие нельзя удалить')
        await tx.lessonEnrollment.deleteMany({ where: { lessonId: lesson.id } })
        await tx.attendanceDraft.deleteMany({ where: { lessonId: lesson.id } })
        await tx.lesson.delete({ where: { id: lesson.id } })
        await audit(lesson.id, lesson.branchId, ['deleted', 'roster'])
      } else if (action === 'assignClientLesson') {
        if (lesson.status === 'cancelled' || lesson.startsAt <= new Date())
          throw new PostgresApiError(409, 'CONFLICT', 'Состав прошлого/отменённого занятия нельзя менять')
        const client = await tx.client.findUnique({ where: { id: String(data.clientId) } })
        if (
          !client ||
          client.branchId !== lesson.branchId ||
          client.status !== 'active' ||
          client.category !== lesson.category
        )
          throw new PostgresApiError(403, 'FORBIDDEN', 'Ученик не соответствует филиалу или секции')
        if (lesson.enrollments.some((entry) => entry.clientId === client.id))
          throw new PostgresApiError(409, 'CONFLICT', 'Ученик уже назначен')
        if (lesson.enrollments.filter((entry) => entry.status === 'active').length >= lesson.capacity)
          throw new PostgresApiError(409, 'CONFLICT', 'Группа заполнена')
        await tx.lessonEnrollment.create({
          data: { lessonId: lesson.id, clientId: client.id, branchId: lesson.branchId },
        })
        await tx.lesson.update({ where: { id: lesson.id }, data: { version: { increment: 1 } } })
        await audit(lesson.id, lesson.branchId, ['roster', 'version'])
      } else {
        if (lesson.status === 'cancelled')
          throw new PostgresApiError(409, 'CONFLICT', 'Отменённое занятие нельзя редактировать')
        if (
          marked &&
          ['date', 'time', 'coachId', 'durationMinutes', 'maxCapacity'].some((field) => data[field] !== undefined)
        )
          throw new PostgresApiError(409, 'CONFLICT', 'Контекст отмеченного занятия нельзя переписать')
        const update: Prisma.LessonUpdateInput = { version: { increment: 1 } }
        if (data.title !== undefined) update.title = String(data.title)
        if (data.pool !== undefined) update.location = String(data.pool)
        if (data.coachId !== undefined) {
          requireAdmin(canonical)
          const profile = await resolveCoach(tx, canonical, lesson.branchId, String(data.coachId))
          update.coach = { connect: { id: profile.id } }
          update.coachMembership = { connect: { coachId_branchId: { coachId: profile.id, branchId: lesson.branchId } } }
        }
        if (data.date || data.time || data.durationMinutes) {
          const date = String(data.date || lesson.localDate.toISOString().slice(0, 10)),
            clock = String(
              data.time ||
                new Intl.DateTimeFormat('en-GB', {
                  timeZone: lesson.timeZone,
                  hour: '2-digit',
                  minute: '2-digit',
                  hourCycle: 'h23',
                }).format(lesson.startsAt),
            )
          const start = await instant(tx, date, clock, lesson.timeZone)
          if (start <= new Date()) throw new PostgresApiError(400, 'VALIDATION', 'Перенос возможен только в будущее')
          update.localDate = new Date(date + 'T00:00:00Z')
          update.startsAt = start
          update.endsAt = new Date(
            start.getTime() +
              Number(
                data.durationMinutes || Math.round((lesson.endsAt.getTime() - lesson.startsAt.getTime()) / 60000),
              ) *
                60000,
          )
        }
        if (data.maxCapacity !== undefined) {
          if (Number(data.maxCapacity) < lesson.enrollments.filter((entry) => entry.status === 'active').length)
            throw new PostgresApiError(409, 'CONFLICT', 'Вместимость меньше состава')
          update.capacity = Number(data.maxCapacity)
        }
        const changes = Object.keys(parsed).filter((field) => !['id', 'requestId', 'expectedVersion'].includes(field))
        if (!changes.length) throw new PostgresApiError(400, 'VALIDATION', 'Нет изменяемых полей')
        await tx.lesson.update({ where: { id: lesson.id }, data: update })
        await audit(lesson.id, lesson.branchId, changes)
      }
      return { success: true }
    },
    async (tx, _result, canonical) => {
      if (action === 'createLesson' || action === 'createLessonWithClients') {
        const lessonId = await mutationEntity(tx, canonical, data.requestId)
        const lesson = await tx.lesson.findUnique({
          where: { id: lessonId },
          include: { coach: { select: { name: true, userId: true } }, _count: { select: { enrollments: true } } },
        })
        if (!lesson) throw new PostgresApiError(409, 'CONFLICT', 'Созданное занятие уже удалено')
        requireLessonScope(lesson, canonical)
        return {
          ...lessonDto(lesson, canonical),
          clientsAssigned: create.parse(parsed).clientIds.length,
          duplicate: true,
        }
      }
      if (action !== 'deleteLesson') {
        const lesson = await tx.lesson.findUnique({
          where: { id: action === 'assignClientLesson' ? String(data.lessonId) : data.id! },
          include: { coach: { select: { name: true, userId: true } } },
        })
        if (!lesson) throw new PostgresApiError(409, 'CONFLICT', 'Занятие уже удалено')
        if (action === 'assignClientLesson') requireAdmin(canonical)
        else requireLessonOwner(lesson, canonical)
      } else requireAdmin(canonical)
      return { success: true, duplicate: true }
    },
    { accountManagement: action.startsWith('create') || action === 'updateLesson' },
  )
}
export async function scheduleRows(db: PrismaClient, actor: Actor, input: unknown = {}) {
  const data = z
    .object({ branchId: id.optional(), from: dateOnlySchema.optional(), to: dateOnlySchema.optional() })
    .strict()
    .parse(input)
  if (data.from && data.to && data.from > data.to) throw new PostgresApiError(400, 'VALIDATION', 'Некорректный период')
  const branchId = branchScope(actor, data.branchId)
  const rows = await db.lesson.findMany({
    where: {
      ...(branchId ? { branchId } : {}),
      ...(data.from || data.to
        ? {
            localDate: {
              ...(data.from ? { gte: new Date(data.from + 'T00:00:00Z') } : {}),
              ...(data.to ? { lte: new Date(data.to + 'T00:00:00Z') } : {}),
            },
          }
        : {}),
    },
    include: { coach: { select: { name: true, userId: true } }, _count: { select: { enrollments: true } } },
    orderBy: [{ localDate: 'asc' }, { startsAt: 'asc' }, { id: 'asc' }],
    take: 5001,
  })
  if (rows.length > 5000) throw new PostgresApiError(422, 'VALIDATION', 'Уточните период: больше 5000 занятий')
  return rows.map((row) => lessonDto(row, actor))
}
