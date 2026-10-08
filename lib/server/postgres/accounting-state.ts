import 'server-only'
import type { Client, Payment, LessonLedgerEntry, Prisma, PrismaClient } from '../../../.generated/prisma/client'
import type { Actor } from './access'
import { authDigest } from './accounts'
import { PostgresApiError } from './errors'
import { packagePrice, packageLessonsFromFrequency } from '../../subscription-pricing'

export function amountMinor(amount: number): bigint {
  const text = String(amount)
  if (!Number.isFinite(amount) || !/^\d+(\.\d{1,2})?$/.test(text))
    throw new PostgresApiError(400, 'VALIDATION', 'Сумма должна содержать не более двух знаков после запятой')
  const [rubles, cents = ''] = text.split('.')
  const value = BigInt(rubles) * BigInt(100) + BigInt(cents.padEnd(2, '0'))
  if (value > BigInt('1000000000000')) throw new PostgresApiError(400, 'VALIDATION', 'Сумма слишком велика')
  return value
}
export function rubles(value: bigint) {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new PostgresApiError(503, 'SERVICE_UNAVAILABLE', 'Денежное значение требует точного формата ответа')
  return Number(value) / 100
}
export const categoryLabel = (value: string) => (value === 'swimming' ? 'плавание' : 'синхронное плавание')
export function accountingSnapshot(client: Client) {
  return {
    remainingLessons: client.remainingLessons,
    totalLessons: client.totalLessons,
    paidAmount: rubles(client.paidAmountMinor),
    paymentBalance: rubles(client.paymentBalanceMinor),
    paidAmountMinor: String(client.paidAmountMinor),
    paymentBalanceMinor: String(client.paymentBalanceMinor),
    category: categoryLabel(client.category),
    lessonsPerWeek: client.lessonsPerWeek,
    status: { active: 'Активен', paused: 'Пауза', archived: 'Архив' }[client.status],
    version: client.version,
  }
}
export async function accountingState(tx: Prisma.TransactionClient | PrismaClient, client: Client, secret: string) {
  const [ledger, payments] = await Promise.all([
    tx.lessonLedgerEntry.findMany({ where: { clientId: client.id }, orderBy: { sequence: 'asc' } }),
    tx.payment.findMany({ where: { clientId: client.id }, orderBy: [{ paidAt: 'asc' }, { id: 'asc' }] }),
  ])
  return calculateAccountingState(client, ledger, payments, secret)
}
export function calculateAccountingState(
  client: Client,
  ledger: LessonLedgerEntry[],
  payments: Payment[],
  secret: string,
) {
  // History displays newest payments first; mutation snapshots load oldest
  // first. The audit token must describe data, not the caller's display order.
  payments = payments.slice().sort((left, right) => {
    const time = left.paidAt.getTime() - right.paidAt.getTime()
    return time || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  })
  let balance = 0,
    total = 0,
    sequence = 0
  const ledgerIssues: string[] = [],
    paymentIssues: string[] = [],
    missingPayments = []
  for (const row of ledger) {
    if (row.sequence !== sequence + 1 || row.balanceBefore !== balance || row.totalBefore !== total)
      ledgerIssues.push('Нарушен порядок или начальные значения журнала')
    balance += row.lessonsDelta
    total += row.totalLessonsDelta
    sequence = row.sequence
    if (
      !Number.isSafeInteger(balance) ||
      !Number.isSafeInteger(total) ||
      balance < 0 ||
      balance > total ||
      row.balanceAfter !== balance ||
      row.totalAfter !== total
    )
      ledgerIssues.push('Нарушена арифметика журнала')
  }
  if (sequence !== client.ledgerVersion) ledgerIssues.push('Версия карточки не соответствует журналу')
  const paidAmount = payments.reduce((sum, row) => sum + row.amountMinor, BigInt(0))
  const paymentBalance = payments.reduce(
    (sum, row) => sum + row.amountMinor - row.packagePriceMinor * BigInt(row.packagesCount),
    BigInt(0),
  )
  for (const payment of payments) {
    const rows = ledger.filter((row) => row.paymentId === payment.id)
    if (!rows.length) missingPayments.push(payment)
    else if (
      rows.length !== 1 ||
      rows[0].type !== 'purchase' ||
      rows[0].lessonsDelta !== payment.lessonsAdded ||
      rows[0].totalLessonsDelta !== payment.lessonsAdded
    )
      paymentIssues.push('Подтверждённый платёж противоречит журналу')
    if (
      payment.amountMinor <= BigInt(0) ||
      payment.packagePriceMinor <= BigInt(0) ||
      payment.lessonsAdded !== payment.packagesCount * payment.packageLessons
    )
      paymentIssues.push('Некорректный снимок начисления платежа')
  }
  if (
    paidAmount !== client.paidAmountMinor ||
    paymentBalance !== client.paymentBalanceMinor ||
    paymentBalance < BigInt(0)
  )
    paymentIssues.push('Денежные итоги карточки не подтверждены платежами; выдумывать платёж запрещено')
  const isConsistent =
    !ledgerIssues.length &&
    !paymentIssues.length &&
    !missingPayments.length &&
    balance === client.remainingLessons &&
    total === client.totalLessons
  const auditFingerprint = authDigest(secret, 'accounting-audit', {
    clientId: client.id,
    version: client.version,
    ledgerVersion: client.ledgerVersion,
    remaining: client.remainingLessons,
    total: client.totalLessons,
    paid: String(client.paidAmountMinor),
    moneyBalance: String(client.paymentBalanceMinor),
    ledger: ledger.map((row) => [
      row.id,
      row.sequence,
      row.lessonsDelta,
      row.totalLessonsDelta,
      row.balanceBefore,
      row.balanceAfter,
      row.totalBefore,
      row.totalAfter,
    ]),
    payments: payments.map((row) => [
      row.id,
      String(row.amountMinor),
      String(row.packagePriceMinor),
      row.packagesCount,
      row.lessonsAdded,
    ]),
  })
  return {
    ledger,
    payments,
    balance,
    total,
    sequence,
    ledgerIssues,
    paymentIssues,
    missingPayments,
    isConsistent,
    auditFingerprint,
  }
}
export function discrepancy(client: Client, state: Awaited<ReturnType<typeof accountingState>>) {
  if (state.isConsistent) return null
  return {
    clientId: client.id,
    childName: client.childName,
    branchId: client.branchId,
    current: { remainingLessons: client.remainingLessons, totalLessons: client.totalLessons },
    calculated: { remainingLessons: state.balance, totalLessons: state.total },
    ledgerIssues: state.ledgerIssues,
    paymentIssues: state.paymentIssues,
    missingPaymentIds: state.missingPayments.map((row) => row.id),
    repairable: !state.ledgerIssues.length && !state.paymentIssues.length,
    auditFingerprint: state.auditFingerprint,
  }
}
export function requireReconciled(state: Awaited<ReturnType<typeof accountingState>>) {
  if (!state.isConsistent)
    throw new PostgresApiError(409, 'CONFLICT', 'Абонемент требует сверки с журналом и платежами')
}
export async function creditPayment(
  tx: Prisma.TransactionClient,
  client: Client,
  actor: Actor,
  requestId: string,
  input: { amount: number; category?: string; lessonsPerWeek?: number; comment?: string },
) {
  const label = input.category || categoryLabel(client.category),
    frequency = input.lessonsPerWeek || client.lessonsPerWeek
  const price = BigInt(packagePrice(label, frequency)) * BigInt(100),
    lessons = packageLessonsFromFrequency(frequency)
  const amount = amountMinor(input.amount),
    available = client.paymentBalanceMinor + amount
  if (amount <= BigInt(0) || !price || !lessons)
    throw new PostgresApiError(400, 'VALIDATION', 'Некорректная сумма или тариф')
  const packages = available / price,
    added = Number(packages) * lessons
  if (!packages) throw new PostgresApiError(422, 'VALIDATION', 'Суммы недостаточно для полного абонемента')
  if (!Number.isSafeInteger(added) || client.totalLessons + added > 2_147_483_647)
    throw new PostgresApiError(400, 'VALIDATION', 'Начисление превышает допустимый остаток')
  const payment = await tx.payment.create({
    data: {
      clientId: client.id,
      branchId: client.branchId,
      actorId: actor.id,
      requestId,
      amountMinor: amount,
      category: label === 'плавание' ? 'swimming' : 'synchronized_swimming',
      lessonsPerWeek: frequency,
      packagePriceMinor: price,
      packageLessons: lessons,
      packagesCount: Number(packages),
      lessonsAdded: added,
      paidAt: new Date(),
      comment: input.comment || null,
    },
  })
  const ledgerEntry = await tx.lessonLedgerEntry.create({
    data: {
      clientId: client.id,
      branchId: client.branchId,
      actorId: actor.id,
      requestId,
      paymentId: payment.id,
      type: 'purchase',
      sequence: client.ledgerVersion + 1,
      lessonsDelta: added,
      totalLessonsDelta: added,
      balanceBefore: client.remainingLessons,
      balanceAfter: client.remainingLessons + added,
      totalBefore: client.totalLessons,
      totalAfter: client.totalLessons + added,
      reason: 'Подтверждённый платёж',
      comment: input.comment || null,
    },
  })
  // D-08 remains a separate business decision: never silently lift a manually
  // paused/archived card merely because money arrived.
  const updated = await tx.client.update({
    where: { id: client.id },
    data: {
      category: payment.category,
      lessonsPerWeek: frequency,
      remainingLessons: { increment: added },
      totalLessons: { increment: added },
      paidAmountMinor: { increment: amount },
      paymentBalanceMinor: available % price,
      purchasedAt: payment.paidAt,
      ledgerVersion: { increment: 1 },
      version: { increment: 1 },
    },
  })
  return { payment, ledgerEntry, updated }
}
export function paymentDto(
  row: Awaited<ReturnType<typeof creditPayment>>['payment'],
  requestKey = '',
  recordedBy = '',
) {
  return {
    id: row.id,
    requestId: requestKey,
    actorId: row.actorId,
    recordedBy,
    clientId: row.clientId,
    amount: rubles(row.amountMinor),
    amountMinor: String(row.amountMinor),
    lessonsAdded: row.lessonsAdded,
    category: categoryLabel(row.category),
    lessonsPerWeek: row.lessonsPerWeek,
    packagePrice: rubles(row.packagePriceMinor),
    packageLessons: row.packageLessons,
    packagesCount: row.packagesCount,
    paidAt: row.paidAt.toISOString(),
    comment: row.comment || '',
  }
}
export function ledgerDto(row: Awaited<ReturnType<typeof creditPayment>>['ledgerEntry'], recordedBy = '') {
  return {
    id: row.id,
    actorId: row.actorId,
    recordedBy,
    clientId: row.clientId,
    paymentId: row.paymentId || '',
    type: row.type,
    lessonsDelta: row.lessonsDelta,
    totalLessonsDelta: row.totalLessonsDelta,
    balanceBefore: row.balanceBefore,
    balanceAfter: row.balanceAfter,
    totalLessonsBefore: row.totalBefore,
    totalLessonsAfter: row.totalAfter,
    createdAt: row.createdAt.toISOString(),
    reason: row.reason,
    comment: row.comment || '',
  }
}
