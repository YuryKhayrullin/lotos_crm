import 'server-only'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { PrismaClient } from '../../../.generated/prisma/client'
import { validateEnvironment } from '../../../scripts/lib/environment.mjs'
import { calculateAccountingState } from './accounting-state'
import { importTargetId, validateTestImport } from './import'
import { PostgresApiError } from './errors'
import { instant } from './schedule'

// This is a reconciliation, never an import/repair. RepeatableRead gives one
// consistent view; READ ONLY also prevents an accidental future writer.
export async function verifyTestImport(db: PrismaClient, input: unknown, values: NodeJS.ProcessEnv) {
  if (!['local', 'test'].includes(String(values.APP_ENV)))
    throw new PostgresApiError(403, 'FORBIDDEN', 'Тестовая сверка запрещена в staging/production')
  validateEnvironment(values, values.APP_ENV)
  const plan = validateTestImport(input)
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      const batch = await tx.importBatch.findUnique({ where: { namespace: plan.namespace } })
      if (!batch) throw new PostgresApiError(404, 'NOT_FOUND', 'Набор ещё не импортирован')
      const digest = createHash('sha256').update(JSON.stringify(plan)).digest('hex')
      if (batch.sourceSha256 !== plan.sourceSha256 || batch.planSha256 !== digest)
        throw new PostgresApiError(409, 'CONFLICT', 'Источник или план не соответствует сохранённому импорту')
      const issues: { code: string; sheet?: string; row?: number }[] = []
      const sourceRows = await tx.importRecord.findMany({ where: { namespace: plan.namespace } })
      const archive = new Map(sourceRows.map((row) => [row.entityType + ':' + row.sourceId, row]))
      const marker = await tx.mutationRequest.findUnique({
        where: { actorId_requestKey: { actorId: batch.actorId, requestKey: 'import:' + plan.namespace } },
      })
      if (!marker || marker.action !== 'importTestDataset') issues.push({ code: 'IMPORT_CONFIRMATION_MISSING' })
      if (sourceRows.length !== plan.records.length) issues.push({ code: 'ARCHIVE_COUNT_MISMATCH' })
      const quantities: {
        sourceRow: number
        remainingLessons: number
        totalLessons: number
        currentRemainingLessons: number
        currentTotalLessons: number
      }[] = []
      let mappedClients = 0,
        mappedCoaches = 0,
        mappedUsers = 0,
        mappedBranches = 0,
        archivedLessons = 0,
        mappedLessons = 0,
        archivedMarks = 0
      for (const row of plan.records) {
        const original = archive.get(row.sheet + ':' + row.sourceId)
        const error = (code: string) => issues.push({ code, sheet: row.sheet, row: row.row })
        const expectedPayload = {
          row: row.row,
          values: row.sheet === 'Платежи' ? {} : row.values,
          dateIso: row.dateIso,
          time: row.time,
        }
        if (
          !original ||
          original.id !== importTargetId(plan.namespace, 'record', row.sheet + ':' + row.sourceId) ||
          !isDeepStrictEqual(original.payload, expectedPayload)
        ) {
          error('SOURCE_ARCHIVE_MISMATCH')
          continue
        }
        const expectedId = importTargetId(plan.namespace, row.sheet, row.sourceId)
        if (row.sheet === 'Users') {
          const admin = row.values.role === '1' || row.values.role === 'admin'
          const targetId = admin ? batch.actorId : expectedId
          const user = await tx.user.findUnique({
            where: { id: targetId },
            include: { accounts: { where: { providerId: 'credential' }, select: { password: true } } },
          })
          if (!user || original.targetId !== targetId || user.role !== (admin ? 'admin' : 'coach'))
            error('ACCOUNT_MAPPING_MISMATCH')
          else mappedUsers++
          if (user?.accounts.some((account) => account.password?.startsWith('scrypt$')))
            error('LEGACY_CREDENTIAL_FOUND')
        } else if (row.sheet === 'Филиалы') {
          const branch = await tx.branch.findUnique({ where: { id: expectedId } })
          if (!branch || original.targetId !== expectedId || branch.timeZone !== plan.timeZone)
            error('BRANCH_MAPPING_MISMATCH')
          else mappedBranches++
        } else if (row.sheet === 'Тренеры') {
          const coach = await tx.coach.findUnique({ where: { id: expectedId }, include: { memberships: true } })
          const oldBranch = importTargetId(plan.namespace, 'Филиалы', row.values.branchId)
          const oldUser = row.values.userId ? importTargetId(plan.namespace, 'Users', row.values.userId) : null
          if (
            !coach ||
            original.targetId !== expectedId ||
            coach.userId !== oldUser ||
            !coach.memberships.some((member) => member.branchId === oldBranch)
          )
            error('COACH_MAPPING_MISMATCH')
          else mappedCoaches++
        } else if (row.sheet === 'Клиенты') {
          const client = await tx.client.findUnique({ where: { id: expectedId } })
          if (
            !client ||
            original.targetId !== expectedId ||
            client.branchId !== importTargetId(plan.namespace, 'Филиалы', row.values.branchId)
          ) {
            error('CLIENT_MAPPING_MISMATCH')
            continue
          }
          mappedClients++
          const [ledger, payments] = await Promise.all([
            tx.lessonLedgerEntry.findMany({ where: { clientId: client.id }, orderBy: { sequence: 'asc' } }),
            tx.payment.findMany({ where: { clientId: client.id }, orderBy: [{ paidAt: 'asc' }, { id: 'asc' }] }),
          ])
          const opening = ledger.find((entry) => entry.id === importTargetId(plan.namespace, 'opening', row.sourceId))
          const remaining = Number(row.values.remainingLessons),
            total = Number(row.values.totalLessons)
          if (
            !opening ||
            opening.type !== 'opening_balance' ||
            opening.requestId !== marker?.id ||
            opening.balanceAfter !== remaining ||
            opening.totalAfter !== total ||
            opening.sequence !== 1
          )
            error('OPENING_CREDITS_MISMATCH')
          if (!calculateAccountingState(client, ledger, payments, values.BETTER_AUTH_SECRET!).isConsistent)
            error('CURRENT_ACCOUNTING_DISCREPANCY')
          quantities.push({
            sourceRow: row.row,
            remainingLessons: remaining,
            totalLessons: total,
            currentRemainingLessons: client.remainingLessons,
            currentTotalLessons: client.totalLessons,
          })
          const history: unknown = JSON.parse(row.values.attendanceHistory || '[]')
          if (!Array.isArray(history)) error('SOURCE_HISTORY_INVALID')
          else archivedMarks += history.length
        } else if (row.sheet === 'Расписание') {
          if (!plan.coachBindings[row.sourceId]) {
            if (
              original.targetId !== null ||
              original.disposition !== 'quarantined' ||
              (await tx.lesson.findUnique({ where: { id: expectedId } }))
            )
              error('UNBOUND_LESSON_WAS_ASSIGNED')
            else archivedLessons++
          } else {
            const lesson = await tx.lesson.findUnique({ where: { id: expectedId }, include: { enrollments: true } })
            if (!lesson || original.targetId !== expectedId || lesson.timeZone !== plan.timeZone)
              error('LESSON_MAPPING_MISMATCH')
            else {
              mappedLessons++
              const rawRoster = row.values.clientIds?.trim()
              const roster: string[] | null =
                plan.rosters[row.sourceId] ??
                (rawRoster
                  ? rawRoster.startsWith('[')
                    ? JSON.parse(rawRoster)
                    : rawRoster
                        .split(',')
                        .map((value) => value.trim())
                        .filter(Boolean)
                  : null)
              const expectedClients = (roster || []).map((sourceId) =>
                importTargetId(plan.namespace, 'Клиенты', sourceId),
              )
              if (
                lesson.version === 1 &&
                (lesson.rosterConfirmed !== (roster !== null) || lesson.enrollments.length !== expectedClients.length)
              )
                error('INITIAL_ROSTER_MISMATCH')
              if (
                lesson.version === 1 &&
                (!row.dateIso ||
                  !row.time ||
                  lesson.localDate.toISOString().slice(0, 10) !== row.dateIso ||
                  lesson.startsAt.getTime() !== (await instant(tx, row.dateIso, row.time, plan.timeZone)).getTime())
              )
                error('INITIAL_OCCURRENCE_MISMATCH')
              if (
                lesson.version === 1 &&
                expectedClients.some((id) => !lesson.enrollments.some((member) => member.clientId === id))
              )
                error('INITIAL_ENROLLMENT_MISSING')
              const [kind, ...parts] = plan.coachBindings[row.sourceId].split(':'),
                sourceId = parts.join(':')
              const coach = await tx.coach.findUnique({ where: { id: lesson.coachId } })
              if (
                lesson.version === 1 &&
                (kind === 'coach'
                  ? lesson.coachId !== importTargetId(plan.namespace, 'Тренеры', sourceId)
                  : coach?.userId !== importTargetId(plan.namespace, 'Users', sourceId))
              )
                error('INITIAL_COACH_MISMATCH')
            }
          }
        } else if (row.sheet === 'Платежи' && original.disposition !== 'excluded_by_owner')
          error('LEGACY_PAYMENT_WAS_IMPORTED')
      }
      if (marker && (await tx.payment.count({ where: { requestId: marker.id } })))
        issues.push({ code: 'IMPORT_CREATED_UNCONFIRMED_PAYMENT' })
      return {
        success: issues.length === 0,
        mode: 'verification',
        writes: 0,
        namespace: plan.namespace,
        sourceSha256: plan.sourceSha256,
        sourceRecords: plan.records.length,
        archivedRecords: sourceRows.length,
        mappedUsers,
        mappedBranches,
        mappedCoaches,
        mappedClients,
        mappedLessons,
        archivedLessons,
        archivedMarks,
        quantities,
        issues,
      }
    },
    { isolationLevel: 'RepeatableRead', timeout: 60000, maxWait: 10000 },
  )
}
