import 'server-only'
import { z } from 'zod'
import type { PrismaClient } from '../../../.generated/prisma/client'
import { requireAdmin, type Actor } from './access'
import { clientDto } from './catalog'
import { PostgresApiError } from './errors'
import { calculateAccountingState, discrepancy, ledgerDto, paymentDto } from './accounting-state'

export async function clientHistory(db: PrismaClient, actor: Actor, input: unknown, secret: string) {
  requireAdmin(actor)
  const data = z
    .object({ clientId: z.string().min(1).max(100), includeAudit: z.boolean().optional() })
    .strict()
    .parse(input)
  return db.$transaction(
    async (tx) => {
      const client = await tx.client.findUnique({ where: { id: data.clientId } })
      if (!client) throw new PostgresApiError(404, 'NOT_FOUND', 'Клиент не найден')
      const [ledger, payments, attendance, attendanceTotal, legacy] = await Promise.all([
        tx.lessonLedgerEntry.findMany({
          where: { clientId: client.id },
          orderBy: { sequence: 'asc' },
          include: { actor: { select: { username: true } } },
        }),
        tx.payment.findMany({
          where: { clientId: client.id },
          orderBy: { paidAt: 'desc' },
          include: { request: { select: { requestKey: true } }, actor: { select: { username: true } } },
        }),
        tx.attendance.findMany({
          where: { clientId: client.id },
          orderBy: { updatedAt: 'desc' },
          take: 200,
          include: {
            events: { orderBy: { version: 'desc' }, take: 1, include: { actor: { select: { username: true } } } },
          },
        }),
        tx.attendance.count({ where: { clientId: client.id } }),
        tx.importRecord.findMany({ where: { entityType: 'Клиенты', targetId: client.id } }),
      ])
      const state = calculateAccountingState(client, ledger, payments, secret),
        item = discrepancy(client, state)
      return {
        success: true,
        legacyHistory: legacy.map((record) => {
          const payload = record.payload as { values?: { attendanceHistory?: string } }
          return { namespace: record.namespace, history: JSON.parse(payload.values?.attendanceHistory || '[]') }
        }),
        attendanceTotal,
        attendanceHistory: attendance.map((mark) => {
          const event = mark.events[0],
            context = event?.lessonSnapshot as Record<string, unknown> | undefined
          return {
            id: mark.id,
            lessonId: mark.lessonId,
            date: context?.date || '',
            status: mark.status,
            recordedBy: event?.actor.username || '',
            lessonContext: context || {},
            version: mark.version,
          }
        }),
        payments: payments.map((row) => paymentDto(row, row.request.requestKey, row.actor.username || '')),
        ledger: ledger
          .slice()
          .reverse()
          .map((row) => ledgerDto(row, row.actor.username || '')),
        ...(data.includeAudit
          ? {
              client: clientDto(client, actor),
              audit: {
                success: true,
                checked: 1,
                discrepancies: item ? [item] : [],
              },
            }
          : {}),
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}
