import 'server-only'
import { z } from 'zod'
import type { PrismaClient } from '../../../.generated/prisma/client'
import { type Actor, requireAdmin } from './access'
import { domainMutation } from './mutations'
import { requestKeySchema } from './auth-input'
import { creditProjectionSchema } from './validation'
import { PostgresApiError } from './errors'
import {
  accountingState,
  accountingSnapshot,
  creditPayment,
  discrepancy,
  requireReconciled,
  paymentDto,
  ledgerDto,
  rubles,
  amountMinor,
} from './accounting-state'

const clientId = z.string().min(1).max(100)
const reason = z.string().trim().min(1).max(500)
const common = { clientId, requestId: requestKeySchema }
export const accountingSchemas = {
  recordPayment: z
    .object({
      ...common,
      amount: z.number().finite().positive(),
      category: z.enum(['плавание', 'синхронное плавание']).optional(),
      lessonsPerWeek: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      comment: z.string().trim().max(2000).default(''),
    })
    .strict(),
  recordAdjustment: z
    .object({
      ...common,
      lessonsDelta: z
        .number()
        .int()
        .min(-100)
        .max(100)
        .refine((value) => value !== 0),
      reason,
      comment: z.string().trim().max(2000).default(''),
    })
    .strict(),
  repairLessonLedger: z
    .object({
      ...common,
      reason,
      confirmed: z.literal(true),
      expectedRemainingLessons: z.number().int().nonnegative(),
      expectedTotalLessons: z.number().int().nonnegative(),
      auditFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
} as const
export type AccountingAction = keyof typeof accountingSchemas
export async function mutateAccounting(
  db: PrismaClient,
  actor: Actor,
  action: AccountingAction,
  input: unknown,
  secret: string,
) {
  requireAdmin(actor)
  const data = accountingSchemas[action].parse(input)
  if (action === 'recordPayment') amountMinor(accountingSchemas.recordPayment.parse(data).amount)
  return domainMutation<unknown>(
    db,
    actor,
    action,
    data.requestId,
    data,
    secret,
    async (tx, canonical, requestId) => {
      requireAdmin(canonical)
      await tx.$queryRaw`SELECT id FROM clients WHERE id=${data.clientId} FOR UPDATE`
      let client = await tx.client.findUnique({ where: { id: data.clientId } })
      if (!client) throw new PostgresApiError(404, 'NOT_FOUND', 'Клиент не найден')
      const state = await accountingState(tx, client, secret)
      const audit = () =>
        tx.auditEvent.create({
          data: {
            actorId: canonical.id,
            requestId,
            action,
            entityType: 'client',
            entityId: client!.id,
            branchId: client!.branchId,
            changedFields: [
              'lessonLedger',
              ...(action === 'recordPayment' ? ['payments', 'paidAmount', 'paymentBalance'] : []),
            ],
            reason: 'reason' in data ? data.reason : null,
          },
        })
      if (action === 'recordPayment') {
        requireReconciled(state)
        const result = await creditPayment(
          tx,
          client,
          canonical,
          requestId,
          accountingSchemas.recordPayment.parse(data),
        )
        await audit()
        return {
          success: true,
          payment: paymentDto(result.payment, data.requestId, canonical.username),
          ledgerEntry: ledgerDto(result.ledgerEntry, canonical.username),
          client: accountingSnapshot(result.updated),
          audit: { success: true, checked: 1, discrepancies: [] },
        }
      }
      if (action === 'recordAdjustment') {
        requireReconciled(state)
        const adjustment = accountingSchemas.recordAdjustment.parse(data)
        const remaining = client.remainingLessons + adjustment.lessonsDelta,
          total = client.totalLessons + adjustment.lessonsDelta
        creditProjectionSchema.parse({ remainingLessons: remaining, totalLessons: total })
        await tx.lessonLedgerEntry.create({
          data: {
            clientId: client.id,
            branchId: client.branchId,
            requestId,
            actorId: canonical.id,
            type: 'adjustment',
            lessonsDelta: adjustment.lessonsDelta,
            totalLessonsDelta: adjustment.lessonsDelta,
            sequence: client.ledgerVersion + 1,
            balanceBefore: client.remainingLessons,
            balanceAfter: remaining,
            totalBefore: client.totalLessons,
            totalAfter: total,
            reason: adjustment.reason,
            comment: adjustment.comment || null,
          },
        })
        client = await tx.client.update({
          where: { id: client.id },
          data: {
            remainingLessons: remaining,
            totalLessons: total,
            version: { increment: 1 },
            ledgerVersion: { increment: 1 },
          },
        })
        await audit()
        return { success: true, client: accountingSnapshot(client) }
      }
      const repair = accountingSchemas.repairLessonLedger.parse(data)
      if (
        repair.auditFingerprint !== state.auditFingerprint ||
        repair.expectedRemainingLessons !== client.remainingLessons ||
        repair.expectedTotalLessons !== client.totalLessons
      )
        throw new PostgresApiError(409, 'CONFLICT', 'Результат аудита устарел. Повторите сверку.')
      if (state.ledgerIssues.length || state.paymentIssues.length)
        throw new PostgresApiError(
          409,
          'CONFLICT',
          'Журнал или подтверждённые платежи противоречивы; автоматическое исправление запрещено',
        )
      // Preserve GAS semantics: confirmed repair brings the ledger to explicitly
      // confirmed CARD credits; it does not invent monetary payments.
      let balance = state.balance,
        total = state.total,
        sequence = state.sequence
      for (const payment of state.missingPayments) {
        await tx.lessonLedgerEntry.create({
          data: {
            clientId: client.id,
            branchId: client.branchId,
            actorId: canonical.id,
            requestId,
            paymentId: payment.id,
            type: 'purchase',
            sequence: ++sequence,
            lessonsDelta: payment.lessonsAdded,
            totalLessonsDelta: payment.lessonsAdded,
            balanceBefore: balance,
            balanceAfter: balance + payment.lessonsAdded,
            totalBefore: total,
            totalAfter: total + payment.lessonsAdded,
            reason: repair.reason,
          },
        })
        balance += payment.lessonsAdded
        total += payment.lessonsAdded
      }
      await tx.lessonLedgerEntry.create({
        data: {
          clientId: client.id,
          branchId: client.branchId,
          actorId: canonical.id,
          requestId,
          type: 'audit_repair',
          sequence: ++sequence,
          lessonsDelta: client.remainingLessons - balance,
          totalLessonsDelta: client.totalLessons - total,
          balanceBefore: balance,
          balanceAfter: client.remainingLessons,
          totalBefore: total,
          totalAfter: client.totalLessons,
          reason: repair.reason,
        },
      })
      await tx.client.update({ where: { id: client.id }, data: { ledgerVersion: sequence, version: { increment: 1 } } })
      await audit()
      return { success: true, repaired: true }
    },
    async (tx, _result, canonical) => {
      requireAdmin(canonical)
      const client = await tx.client.findUnique({ where: { id: data.clientId } })
      if (!client) throw new PostgresApiError(409, 'CONFLICT', 'Карточка требует сверки')
      if (action !== 'recordPayment') return { success: true, duplicate: true, client: accountingSnapshot(client) }
      const marker = await tx.mutationRequest.findUniqueOrThrow({
        where: { actorId_requestKey: { actorId: canonical.id, requestKey: data.requestId } },
      })
      const payment = await tx.payment.findFirstOrThrow({
        where: { requestId: marker.id, clientId: client.id },
        include: { ledger: true },
      })
      if (!payment.ledger) throw new PostgresApiError(409, 'CONFLICT', 'Платёж требует сверки с журналом')
      const state = await accountingState(tx, client, secret),
        item = discrepancy(client, state)
      return {
        success: true,
        duplicate: true,
        payment: paymentDto(payment, data.requestId, canonical.username),
        ledgerEntry: ledgerDto(payment.ledger, canonical.username),
        client: accountingSnapshot(client),
        audit: { success: true, checked: 1, discrepancies: item ? [item] : [] },
      }
    },
  )
}
export async function auditAccounting(db: PrismaClient, actor: Actor, input: unknown, secret: string) {
  requireAdmin(actor)
  const data = z.object({ clientId: clientId.optional(), branchId: clientId.optional() }).strict().parse(input)
  return db.$transaction(
    async (tx) => {
      const clients = await tx.client.findMany({
        where: {
          ...(data.clientId ? { id: data.clientId } : {}),
          ...(data.branchId ? { branchId: data.branchId } : {}),
        },
      })
      if (data.clientId && !clients.length) throw new PostgresApiError(404, 'NOT_FOUND', 'Клиент не найден')
      const discrepancies = []
      for (const client of clients) {
        const item = discrepancy(client, await accountingState(tx, client, secret))
        if (item) discrepancies.push(item)
      }
      return { success: true, checked: clients.length, discrepancies }
    },
    { isolationLevel: 'RepeatableRead', timeout: 20_000 },
  )
}
export async function financeSummary(db: PrismaClient, actor: Actor, input: unknown) {
  requireAdmin(actor)
  const data = z.object({ branchId: clientId.optional() }).strict().parse(input),
    where = data.branchId ? { branchId: data.branchId } : {}
  return db.$transaction(
    async (tx) => {
      const [totals, statuses] = await Promise.all([
        tx.client.aggregate({
          where,
          _count: { id: true },
          _sum: { paidAmountMinor: true, remainingLessons: true, totalLessons: true },
        }),
        tx.client.groupBy({ by: ['status'], where, _count: { id: true } }),
      ])
      const count = (status: string) => statuses.find((row) => row.status === status)?._count.id || 0
      return {
        totalClients: totals._count.id,
        activeClients: count('active'),
        pausedClients: count('paused'),
        archivedClients: count('archived'),
        totalPaidAmount: rubles(totals._sum.paidAmountMinor || BigInt(0)),
        totalPaidAmountMinor: String(totals._sum.paidAmountMinor || BigInt(0)),
        remainingLessons: totals._sum.remainingLessons || 0,
        totalLessons: totals._sum.totalLessons || 0,
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}
