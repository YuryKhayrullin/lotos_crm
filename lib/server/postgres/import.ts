import 'server-only'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { PrismaClient, Prisma } from '../../../.generated/prisma/client'
import { validateEnvironment } from '../../../scripts/lib/environment.mjs'
import { creditProjectionSchema, usernameSchema } from './validation'
import { PostgresApiError } from './errors'
import { calculateAccountingState } from './accounting-state'
import { authDigest } from './accounts'
import { instant } from './schedule'

const id = z.string().min(1).max(150)
const sheet = z.enum([
  'Users',
  'Филиалы',
  'Тренеры',
  'Клиенты',
  'Расписание',
  'Платежи',
  'Журнал занятий',
  'Посещения',
  'Журнал администрирования',
  'Создание занятий',
])
export const testImportSchema = z
  .object({
    version: z.literal(1),
    testOnly: z.literal(true),
    namespace: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,79}$/),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    timeZone: z.literal('Europe/Moscow'),
    skipLegacyFinance: z.literal(true),
    credentialPolicy: z.literal('disabled-reset-required'),
    records: z
      .array(
        z
          .object({
            sheet,
            sourceId: id,
            row: z.number().int().positive(),
            values: z.record(z.string().max(100), z.string().max(100000)),
            dateIso: z.iso.date().nullable(),
            birthDateIso: z.iso.date().nullable(),
            time: z
              .string()
              .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
              .nullable(),
          })
          .strict(),
      )
      .max(50000),
    coachBindings: z.record(z.string(), z.string().regex(/^(coach|user):.+$/)).default({}),
    rosters: z.record(z.string(), z.array(id).max(100)).default({}),
  })
  .strict()
export type TestImportPlan = z.infer<typeof testImportSchema>
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export const importTargetId = (namespace: string, kind: string, sourceId: string) =>
  'import-' + sha(JSON.stringify([namespace, kind, sourceId])).slice(0, 48)
const integer = (value: string | undefined) => {
  if (!value || !/^-?\d+$/.test(value))
    throw new PostgresApiError(400, 'VALIDATION', 'Некорректное целое значение источника')
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new PostgresApiError(400, 'VALIDATION', 'Число вне допустимого диапазона')
  return result
}
const category = (value: string) => {
  if (!['плавание', 'синхронное плавание'].includes(value))
    throw new PostgresApiError(400, 'VALIDATION', 'Неизвестная секция источника')
  return value === 'плавание' ? ('swimming' as const) : ('synchronized_swimming' as const)
}
const list = (value: string | undefined): string[] | null => {
  if (!value?.trim()) return null
  const parsed: unknown = value.startsWith('[')
    ? JSON.parse(value)
    : value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
  if (
    !Array.isArray(parsed) ||
    parsed.some((v) => typeof v !== 'string' || !v) ||
    new Set(parsed).size !== parsed.length
  )
    throw new PostgresApiError(400, 'VALIDATION', 'Некорректный состав источника')
  return parsed as string[]
}
const name = z.string().trim().min(1).max(150)
export function validateTestImport(input: unknown) {
  const plan = testImportSchema.parse(input)
  const keys = new Set<string>()
  for (const row of plan.records) {
    const key = row.sheet + ':' + row.sourceId
    if (keys.has(key)) throw new PostgresApiError(409, 'CONFLICT', 'Повтор sourceId в плане')
    keys.add(key)
    if (Object.keys(row.values).some((key) => /password|secret|token|signature/i.test(key)))
      throw new PostgresApiError(400, 'VALIDATION', 'План не должен содержать credentials')
    if (row.values.birthDate && !row.birthDateIso)
      throw new PostgresApiError(400, 'VALIDATION', 'Дата рождения требует явного разбора')
    if (row.sheet === 'Клиенты' && row.values.receiptUrl?.trim())
      throw new PostgresApiError(
        400,
        'VALIDATION',
        'Исходник содержит документы: требуется отдельный план переноса файлов',
      )
  }
  for (const client of plan.records.filter((row) => row.sheet === 'Клиенты')) {
    let balance = 0,
      total = 0
    for (const row of plan.records.filter(
      (row) => row.sheet === 'Журнал занятий' && row.values.clientId === client.sourceId,
    )) {
      if (
        row.values.branchId !== client.values.branchId ||
        integer(row.values.balanceBefore) !== balance ||
        integer(row.values.totalLessonsBefore) !== total
      )
        throw new PostgresApiError(409, 'CONFLICT', 'Нарушена исходная последовательность журнала')
      balance += integer(row.values.lessonsDelta)
      total += integer(row.values.totalLessonsDelta)
      if (
        balance < 0 ||
        balance > total ||
        integer(row.values.balanceAfter) !== balance ||
        integer(row.values.totalLessonsAfter) !== total
      )
        throw new PostgresApiError(409, 'CONFLICT', 'Нарушена исходная арифметика журнала')
    }
    if (balance !== integer(client.values.remainingLessons) || total !== integer(client.values.totalLessons))
      throw new PostgresApiError(409, 'CONFLICT', 'Остатки источника не подтверждены журналом')
  }
  return plan
}
const importReportSchema = z.object({
  namespace: z.string(),
  sourceSha256: z.string(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  boundLessons: z.number().int().nonnegative(),
  requiresCredentialReset: z.boolean(),
  legacyFinanceExcluded: z.boolean(),
  unboundLessonsQuarantined: z.boolean(),
  mode: z.literal('applied'),
  writes: z.number().int().nonnegative(),
  importedLessons: z.number().int().nonnegative(),
  quarantinedLessons: z.number().int().nonnegative(),
  importedAttendance: z.number().int().nonnegative(),
  archivedHistoryMarks: z.number().int().nonnegative(),
})
export function testImportSummary(input: unknown) {
  const plan = validateTestImport(input)
  const counts: Record<string, number> = {}
  for (const row of plan.records) counts[row.sheet] = (counts[row.sheet] || 0) + 1
  const bound = new Set(Object.keys(plan.coachBindings))
  return {
    namespace: plan.namespace,
    sourceSha256: plan.sourceSha256,
    counts,
    boundLessons: plan.records.filter((r) => r.sheet === 'Расписание' && bound.has(r.sourceId)).length,
    requiresCredentialReset: true,
    legacyFinanceExcluded: true,
    unboundLessonsQuarantined: true,
    mode: 'dry-run',
    writes: 0,
  }
}
export async function applyTestImport(db: PrismaClient, input: unknown, actorId: string, values: NodeJS.ProcessEnv) {
  if (!['local', 'test'].includes(String(values.APP_ENV)))
    throw new PostgresApiError(403, 'FORBIDDEN', 'Тестовый импорт запрещён в staging/production')
  validateEnvironment(values, values.APP_ENV)
  const plan = validateTestImport(input),
    planSha256 = sha(JSON.stringify(plan))
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${plan.sourceSha256 + ':test-import-source'},0))`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${plan.namespace + ':test-import'},0))`
      await tx.$queryRaw`SELECT id FROM users WHERE id=${actorId} FOR SHARE`
      const actor = await tx.user.findUnique({ where: { id: actorId } })
      if (!actor || actor.role !== 'admin' || actor.status !== 'active')
        throw new PostgresApiError(403, 'FORBIDDEN', 'Нужен существующий активный владелец-администратор')
      const previous = await tx.importBatch.findUnique({ where: { namespace: plan.namespace } })
      if (previous) {
        if (previous.sourceSha256 !== plan.sourceSha256 || previous.planSha256 !== planSha256)
          throw new PostgresApiError(409, 'CONFLICT', 'Namespace уже использован с другим источником/планом')
        return { duplicate: true, report: importReportSchema.parse(previous.report) }
      }
      if (await tx.importBatch.findFirst({ where: { sourceSha256: plan.sourceSha256 } }))
        throw new PostgresApiError(409, 'CONFLICT', 'Этот источник уже импортирован в другом namespace')
      const target = (kind: string, old: string) => importTargetId(plan.namespace, kind, old)
      const rows = (kind: string) => plan.records.filter((r) => r.sheet === kind)
      const disposition = new Map<string, string>(),
        targets = new Map<string, string>()
      const remember = (kind: string, old: string, newId: string, state = 'imported') => {
        targets.set(kind + ':' + old, newId)
        disposition.set(kind + ':' + old, state)
      }
      const report = {
        ...testImportSummary(plan),
        mode: 'applied',
        writes: plan.records.length,
        importedLessons: 0,
        quarantinedLessons: 0,
        importedAttendance: 0,
        archivedHistoryMarks: 0,
      }
      const marker = await tx.mutationRequest.create({
        data: {
          actorId,
          requestKey: 'import:' + plan.namespace,
          action: 'importTestDataset',
          fingerprint: authDigest(values.BETTER_AUTH_SECRET!, 'test-import', planSha256),
          result: {},
        },
      })
      for (const row of rows('Филиалы')) {
        await tx.branch.create({
          data: {
            id: target(row.sheet, row.sourceId),
            name: name.parse(row.values.name),
            address: z
              .string()
              .max(300)
              .parse(row.values.address || ''),
            timeZone: plan.timeZone,
          },
        })
        remember(row.sheet, row.sourceId, target(row.sheet, row.sourceId))
      }
      const branch = (old: string) => {
        const value = targets.get('Филиалы:' + old)
        if (!value) throw new PostgresApiError(400, 'VALIDATION', 'Не найден филиал источника')
        return value
      }
      for (const row of rows('Users')) {
        const role = row.values.role
        if (role === '1' || role === 'admin') {
          remember(row.sheet, row.sourceId, actorId)
          continue
        }
        if (role !== '2' && role !== 'coach') throw new PostgresApiError(400, 'VALIDATION', 'Неизвестная роль')
        const newId = target(row.sheet, row.sourceId)
        await tx.user.create({
          data: {
            id: newId,
            name: name.parse(row.values.username),
            username: usernameSchema.parse(row.values.username),
            role: 'coach',
            status: 'disabled',
            branchId: row.values.branchId ? branch(row.values.branchId) : null,
            disabledAt: new Date(),
          },
        })
        remember(row.sheet, row.sourceId, newId, 'credential_reset_required')
      }
      for (const row of rows('Тренеры')) {
        const newId = target(row.sheet, row.sourceId),
          userId = row.values.userId ? targets.get('Users:' + row.values.userId) : null
        if (row.values.userId && !userId) throw new PostgresApiError(400, 'VALIDATION', 'Не найден аккаунт профиля')
        const branchId = branch(row.values.branchId)
        if (userId) {
          const user = await tx.user.findUniqueOrThrow({ where: { id: userId } })
          if (user.role !== 'coach' || user.branchId !== branchId)
            throw new PostgresApiError(400, 'VALIDATION', 'Профиль/аккаунт разных филиалов')
        }
        await tx.coach.create({
          data: {
            id: newId,
            branchId,
            userId,
            name: name.parse(row.values.name),
            specialty: z
              .string()
              .max(150)
              .parse(row.values.specialty || 'Тренер'),
            phone: row.values.phone ? z.string().max(40).parse(row.values.phone) : null,
            birthDate: row.birthDateIso ? new Date(row.birthDateIso) : null,
          },
        })
        await tx.coachBranch.create({ data: { id: target('membership', row.sourceId), coachId: newId, branchId } })
        remember(row.sheet, row.sourceId, newId)
      }
      for (const row of rows('Клиенты')) {
        const newId = target(row.sheet, row.sourceId),
          credits = creditProjectionSchema.parse({
            remainingLessons: integer(row.values.remainingLessons),
            totalLessons: integer(row.values.totalLessons),
          })
        const frequency = integer(row.values.lessonsPerWeek)
        if (![1, 2, 3].includes(frequency)) throw new PostgresApiError(400, 'VALIDATION', 'Неизвестная частота')
        const status = z.enum(['Активен', 'Пауза', 'Архив']).parse(row.values.status)
        const client = await tx.client.create({
          data: {
            id: newId,
            branchId: branch(row.values.branchId),
            childName: name.parse(row.values.childName),
            parentName: name.parse(row.values.parentName),
            phone: row.values.phone ? z.string().max(40).parse(row.values.phone) : null,
            email: row.values.email ? z.string().max(254).parse(row.values.email) : null,
            birthDate: row.birthDateIso ? new Date(row.birthDateIso) : null,
            category: category(row.values.category),
            lessonsPerWeek: frequency,
            status: { Активен: 'active' as const, Пауза: 'paused' as const, Архив: 'archived' as const }[status],
            ...credits,
            ledgerVersion: 1,
          },
        })
        await tx.lessonLedgerEntry.create({
          data: {
            id: target('opening', row.sourceId),
            clientId: newId,
            branchId: client.branchId,
            actorId,
            requestId: marker.id,
            type: 'opening_balance',
            sequence: 1,
            lessonsDelta: credits.remainingLessons,
            totalLessonsDelta: credits.totalLessons,
            balanceBefore: 0,
            balanceAfter: credits.remainingLessons,
            totalBefore: 0,
            totalAfter: credits.totalLessons,
            reason:
              'Подтверждённый журналом количественный остаток тестового источника; старые деньги не являются новым платежом',
          },
        })
        remember(row.sheet, row.sourceId, newId)
        let marks: unknown
        try {
          marks = JSON.parse(row.values.attendanceHistory || '[]')
        } catch {
          throw new PostgresApiError(400, 'VALIDATION', 'Повреждена история')
        }
        if (!Array.isArray(marks)) throw new PostgresApiError(400, 'VALIDATION', 'Повреждена история')
        report.archivedHistoryMarks += marks.length
      }
      for (const row of rows('Расписание')) {
        const binding = plan.coachBindings[row.sourceId]
        if (!binding) {
          report.quarantinedLessons++
          continue
        }
        const [kind, ...parts] = binding.split(':'),
          sourceId = parts.join(':')
        let coachId = kind === 'coach' ? targets.get('Тренеры:' + sourceId) : undefined
        const branchId = branch(row.values.branchId)
        if (kind === 'user') {
          const userId = targets.get('Users:' + sourceId),
            user = userId ? await tx.user.findUnique({ where: { id: userId } }) : null
          if (!user || user.role !== 'coach' || user.branchId !== branchId)
            throw new PostgresApiError(400, 'VALIDATION', 'Привязка тренера не соответствует филиалу')
          const coach = await tx.coach.findUnique({ where: { userId: user.id } })
          if (coach) coachId = coach.id
          else {
            coachId = target('account-coach', sourceId)
            await tx.coach.create({ data: { id: coachId, branchId, userId: user.id, name: user.name } })
            await tx.coachBranch.create({ data: { id: target('account-membership', sourceId), coachId, branchId } })
          }
        }
        if (
          !coachId ||
          (await tx.coach.findUniqueOrThrow({ where: { id: coachId } })).branchId !== branchId ||
          !row.dateIso ||
          !row.time
        )
          throw new PostgresApiError(400, 'VALIDATION', 'Некорректная явная привязка/дата занятия')
        if (['true', '1'].includes(row.values.isRecurring))
          throw new PostgresApiError(400, 'VALIDATION', 'Для серии нужен отдельный явный план экземпляров')
        const roster = plan.rosters[row.sourceId] ?? list(row.values.clientIds)
        const capacity = integer(row.values.maxCapacity || '10')
        if (capacity < 1 || capacity > 100 || (roster && roster.length > capacity))
          throw new PostgresApiError(400, 'VALIDATION', 'Некорректная вместимость')
        const hours = row.values.duration?.match(/(\d+)\s*час/),
          mins = row.values.duration?.match(/(\d+)\s*мин/)
        const minutes = Number(hours?.[1] || 0) * 60 + Number(mins?.[1] || 0)
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
          throw new PostgresApiError(400, 'VALIDATION', 'Неоднозначная длительность')
        const start = await instant(tx, row.dateIso, row.time, plan.timeZone),
          newId = target(row.sheet, row.sourceId)
        const lesson = await tx.lesson.create({
          data: {
            id: newId,
            branchId,
            coachId,
            createdById: actorId,
            title: name.parse(row.values.title),
            category: category(row.values.category),
            location: z
              .string()
              .max(150)
              .parse(row.values.pool || ''),
            localDate: new Date(row.dateIso),
            timeZone: plan.timeZone,
            startsAt: start,
            endsAt: new Date(start.getTime() + minutes * 60000),
            capacity,
            rosterConfirmed: roster !== null,
          },
        })
        for (const oldClient of roster || []) {
          const clientId = targets.get('Клиенты:' + oldClient),
            client = clientId ? await tx.client.findUnique({ where: { id: clientId } }) : null
          if (!client || client.branchId !== branchId || client.category !== lesson.category)
            throw new PostgresApiError(400, 'VALIDATION', 'Состав не соответствует клиентам филиала/секции')
          await tx.lessonEnrollment.create({
            data: {
              id: target('enrollment', row.sourceId + ':' + oldClient),
              lessonId: newId,
              clientId: client.id,
              branchId,
            },
          })
        }
        remember(row.sheet, row.sourceId, newId)
        report.importedLessons++
      }
      // Complete source evidence is retained separately; incomplete marks never
      // fabricate native lessons or spend credits again.
      for (const row of rows('Клиенты')) {
        const clientId = targets.get('Клиенты:' + row.sourceId)!
        const marks = z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(row.values.attendanceHistory || '[]'))
        let attended = 0
        for (const mark of marks) {
          const oldLesson = String(mark.lessonId || ''),
            lessonId = targets.get('Расписание:' + oldLesson)
          if (!lessonId) continue
          const lesson = await tx.lesson.findUniqueOrThrow({ where: { id: lessonId } })
          if (!lesson.rosterConfirmed || String(mark.date) !== lesson.localDate.toISOString().slice(0, 10)) continue
          const enrollment = await tx.lessonEnrollment.findUnique({
            where: { lessonId_clientId: { lessonId, clientId } },
          })
          if (!enrollment) continue
          const status = z.enum(['attended', 'absent']).parse(mark.status)
          attended += status === 'attended' ? 1 : 0
          const attendance = await tx.attendance.create({
            data: {
              id: target('attendance', row.sourceId + ':' + oldLesson),
              enrollmentId: enrollment.id,
              lessonId,
              clientId,
              branchId: lesson.branchId,
              status,
            },
          })
          await tx.attendanceEvent.create({
            data: {
              id: target('event', row.sourceId + ':' + oldLesson),
              attendanceId: attendance.id,
              clientId,
              branchId: lesson.branchId,
              actorId,
              requestId: marker.id,
              status,
              version: 1,
              reason: 'Импорт текущей старой отметки без повторного списания; исходный автор хранится в import_records',
              lessonSnapshot: {
                date: row.dateIso || lesson.localDate.toISOString().slice(0, 10),
                title: lesson.title,
                timeZone: lesson.timeZone,
                startsAt: lesson.startsAt.toISOString(),
                coachId: lesson.coachId,
              },
            },
          })
          report.importedAttendance++
        }
        const client = await tx.client.findUniqueOrThrow({ where: { id: clientId } })
        if (attended > client.totalLessons - client.remainingLessons)
          throw new PostgresApiError(409, 'CONFLICT', 'Текущие отметки противоречат подтверждённому расходу')
        const ledger = await tx.lessonLedgerEntry.findMany({ where: { clientId }, orderBy: { sequence: 'asc' } })
        if (!calculateAccountingState(client, ledger, [], values.BETTER_AUTH_SECRET!).isConsistent)
          throw new PostgresApiError(409, 'CONFLICT', 'Импортируемый остаток не прошёл сверку')
      }
      await tx.importBatch.create({
        data: { namespace: plan.namespace, sourceSha256: plan.sourceSha256, planSha256, actorId, report },
      })
      for (const row of plan.records) {
        const key = row.sheet + ':' + row.sourceId
        const state = row.sheet === 'Платежи' ? 'excluded_by_owner' : disposition.get(key) || 'quarantined'
        await tx.importRecord.create({
          data: {
            id: target('record', key),
            namespace: plan.namespace,
            entityType: row.sheet,
            sourceId: row.sourceId,
            targetId: targets.get(key) || null,
            disposition: state,
            payload: {
              row: row.row,
              values: row.sheet === 'Платежи' ? {} : row.values,
              dateIso: row.dateIso,
              time: row.time,
            } as Prisma.InputJsonObject,
          },
        })
      }
      // Immutable batch: compute the final report in its audit child, never UPDATE.
      await tx.auditEvent.create({
        data: {
          actorId,
          requestId: marker.id,
          action: 'importTestDataset',
          entityType: 'import',
          entityId: plan.namespace,
          changedFields: ['catalog', 'openingBalances', 'verifiedLessons', 'sourceArchive'],
          reason: 'Импорт тестового набора; старые деньги исключены, неподтверждённая история сохранена отдельно',
        },
      })
      return { duplicate: false, report }
    },
    { timeout: 60000, maxWait: 10000 },
  )
}
