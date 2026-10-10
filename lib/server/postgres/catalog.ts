import 'server-only'
import { z } from 'zod'
import { hashPassword } from 'better-auth/crypto'
import type { Client, Coach, Prisma, PrismaClient } from '../../../.generated/prisma/client'
import { branchScope, requireAdmin, type Actor } from './access'
import { requestKeySchema, passwordSchema } from './auth-input'
import { dateOnlySchema, usernameSchema, timeZoneSchema } from './validation'
import { PostgresApiError } from './errors'
import { amountMinor, creditPayment } from './accounting-state'
import { domainMutation, mutationEntity } from './mutations'

const id = z.string().trim().min(1).max(100)
const text = (length: number) => z.string().trim().min(1).max(length)
const optionalText = (length: number) => z.string().trim().max(length).optional()
const birthDate = z
  .string()
  .refine((value) => {
    if (!value) return true
    const parts = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
    if (!parts) return false
    const iso = `${parts[3]}-${parts[2]}-${parts[1]}`
    return dateOnlySchema.safeParse(iso).success && iso >= '1900-01-01' && iso <= new Date().toISOString().slice(0, 10)
  }, 'Некорректная дата рождения')
  .optional()
const category = z.enum(['плавание', 'синхронное плавание'])
const status = z.enum(['Активен', 'Пауза', 'Архив'])
const fields = {
  childName: text(150),
  parentName: text(150),
  phone: optionalText(40),
  email: z.union([z.literal(''), z.email().max(254)]).optional(),
  birthDate,
  category: category.default('плавание'),
  lessonsPerWeek: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  comment: optionalText(2000),
}
export const catalogSchemas = {
  createBranch: z
    .object({
      requestId: requestKeySchema,
      name: text(150),
      address: text(300),
      timeZone: timeZoneSchema.default('Europe/Moscow'),
    })
    .strict(),
  createClient: z
    .object({
      ...fields,
      requestId: requestKeySchema,
      branchId: id,
      status: status.default('Активен'),
      paidAmount: z.number().finite().min(0).default(0),
      age: optionalText(40),
      initials: optionalText(10),
    })
    .strict(),
  updateClient: z
    .object({ ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.optional()])) })
    .extend({
      id,
      requestId: requestKeySchema,
      expectedVersion: z.number().int().positive(),
      status: status.optional(),
      category: category.optional(),
      lessonsPerWeek: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      age: optionalText(40),
      initials: optionalText(10),
    })
    .strict(),
  deleteClient: z.object({ id, requestId: requestKeySchema, expectedVersion: z.number().int().positive() }).strict(),
  createCoach: z
    .object({
      requestId: requestKeySchema,
      name: text(150),
      branchId: id,
      specialty: text(150).default('Тренер'),
      phone: optionalText(40),
      birthDate,
      initials: optionalText(10),
      username: usernameSchema.optional(),
      password: passwordSchema.optional(),
    })
    .strict()
    .refine((value) => Boolean(value.username) === Boolean(value.password), 'Нужны и логин, и пароль'),
  deleteCoach: z.object({ id, requestId: requestKeySchema }).strict(),
} as const
export type CatalogAction = keyof typeof catalogSchemas
export const categoryValue = (value: string) =>
  value === 'синхронное плавание' ? ('synchronized_swimming' as const) : ('swimming' as const)
export const statusValue = (value: string) =>
  (({ Активен: 'active', Пауза: 'paused', Архив: 'archived' }) as const)[value as 'Активен' | 'Пауза' | 'Архив']
const dateValue = (value: string | undefined) =>
  value ? new Date(value.split('.').reverse().join('-') + 'T00:00:00Z') : null
export const displayDate = (value: Date | null) =>
  value?.toISOString().slice(0, 10).split('-').reverse().join('.') || ''
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
function rubles(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new PostgresApiError(503, 'SERVICE_UNAVAILABLE', 'Денежное значение требует точного формата ответа')
  return Number(value) / 100
}
export function clientDto(client: Client & { _count?: Record<string, number> }, actor: Actor) {
  const base = {
    id: client.id,
    childName: client.childName,
    branchId: client.branchId,
    status: { active: 'Активен', paused: 'Пауза', archived: 'Архив' }[client.status],
    category: client.category === 'swimming' ? 'плавание' : 'синхронное плавание',
    remainingLessons: client.remainingLessons,
    initials: initials(client.childName),
    version: client.version,
  }
  if (actor.role !== 'admin') return base
  const age = client.birthDate
    ? Math.max(
        0,
        new Date().getUTCFullYear() -
          client.birthDate.getUTCFullYear() -
          (new Date().toISOString().slice(5, 10) < client.birthDate.toISOString().slice(5, 10) ? 1 : 0),
      )
    : 0
  return {
    ...base,
    parentName: client.parentName,
    phone: client.phone || '',
    email: client.email || '',
    birthDate: displayDate(client.birthDate),
    age: `${age} лет`,
    lessonsPerWeek: client.lessonsPerWeek,
    totalLessons: client.totalLessons,
    paidAmount: rubles(client.paidAmountMinor),
    paymentBalance: rubles(client.paymentBalanceMinor),
    paid: client.paidAmountMinor > BigInt(0),
    purchasedAt: client.purchasedAt?.toISOString() || '',
    comment: client.comment || '',
    canDelete: client._count
      ? !Object.values(client._count).some(Boolean) &&
        client.remainingLessons === 0 &&
        client.totalLessons === 0 &&
        client.paidAmountMinor === BigInt(0) &&
        client.paymentBalanceMinor === BigInt(0)
      : undefined,
    receiptUrl: client.receiptDocumentId ? '/api/receipts/' + encodeURIComponent(client.id) : '',
    receiptVersion: client.receiptVersion,
  }
}
export function coachDto(coach: Coach, actor: Actor) {
  const base = {
    id: coach.id,
    name: coach.name,
    specialty: coach.specialty,
    branchId: coach.branchId,
    initials: initials(coach.name),
  }
  return actor.role === 'admin'
    ? { ...base, userId: coach.userId || '', phone: coach.phone || '', birthDate: displayDate(coach.birthDate) }
    : base
}
export async function requireBranch(tx: Prisma.TransactionClient | PrismaClient, branchId: string) {
  const branch = await tx.branch.findUnique({ where: { id: branchId } })
  if (!branch || branch.archivedAt) throw new PostgresApiError(404, 'NOT_FOUND', 'Филиал не найден')
  return branch
}
export async function mutateCatalog(
  db: PrismaClient,
  actor: Actor,
  action: CatalogAction,
  input: unknown,
  secret: string,
) {
  requireAdmin(actor)
  const parsed = catalogSchemas[action].parse(input)
  const data = parsed as Record<string, unknown> & {
    requestId: string
    id?: string
    branchId?: string
    expectedVersion?: number
  }
  if (action === 'createClient') amountMinor(Number(data.paidAmount))
  const password =
    action === 'createCoach' && typeof data.password === 'string' ? await hashPassword(data.password) : null
  return domainMutation<unknown>(
    db,
    actor,
    action,
    data.requestId,
    parsed,
    secret,
    async (tx, canonical, requestId) => {
      requireAdmin(canonical)
      const audit = (entityType: string, entityId: string, branchId: string | null, changedFields: string[]) =>
        tx.auditEvent.create({
          data: { requestId, actorId: canonical.id, action, entityType, entityId, branchId, changedFields },
        })
      if (action === 'createBranch') {
        const branch = await tx.branch.create({
          data: { name: String(data.name), address: String(data.address), timeZone: String(data.timeZone) },
        })
        await audit('branch', branch.id, branch.id, ['name', 'address', 'timeZone'])
        return branch
      }
      if (action === 'createClient') {
        await requireBranch(tx, data.branchId!)
        let client = await tx.client.create({
          data: {
            branchId: data.branchId!,
            childName: String(data.childName),
            parentName: String(data.parentName),
            phone: String(data.phone || '') || null,
            email: String(data.email || '') || null,
            birthDate: dateValue(data.birthDate as string | undefined),
            category: categoryValue(String(data.category)),
            lessonsPerWeek: Number(data.lessonsPerWeek),
            status: statusValue(String(data.status)),
            comment: String(data.comment || '') || null,
          },
        })
        if (Number(data.paidAmount) > 0) {
          const payment = await creditPayment(tx, client, canonical, requestId, {
            amount: Number(data.paidAmount),
            category: String(data.category),
            lessonsPerWeek: Number(data.lessonsPerWeek),
            comment: String(data.comment || ''),
          })
          client = payment.updated
        }
        await audit('client', client.id, client.branchId, [
          'childName',
          'parentName',
          'branchId',
          'category',
          'lessonsPerWeek',
          'status',
          ...(Number(data.paidAmount) > 0 ? ['payments', 'lessonLedger', 'paidAmount', 'paymentBalance'] : []),
        ])
        return clientDto(client, canonical)
      }
      if (action === 'updateClient' || action === 'deleteClient') {
        await tx.$queryRaw`SELECT id FROM clients WHERE id = ${data.id!} FOR UPDATE`
        const client = await tx.client.findUnique({
          where: { id: data.id },
          include: {
            _count: {
              select: {
                enrollments: true,
                seriesEnrollments: true,
                payments: true,
                ledger: true,
                documents: true,
                documentUploads: true,
              },
            },
          },
        })
        if (!client) throw new PostgresApiError(404, 'NOT_FOUND', 'Клиент не найден')
        if (client.version !== data.expectedVersion)
          throw new PostgresApiError(409, 'CONFLICT', 'Карточка изменилась. Обновите данные.')
        if (action === 'deleteClient') {
          if (
            Object.values(client._count).some(Boolean) ||
            client.remainingLessons ||
            client.totalLessons ||
            client.paidAmountMinor ||
            client.paymentBalanceMinor
          )
            throw new PostgresApiError(409, 'CONFLICT', 'Карточка не пустая: используйте архивирование')
          await audit('client', client.id, client.branchId, ['deleted'])
          await tx.client.delete({ where: { id: client.id } })
        } else {
          const changes: Prisma.ClientUpdateInput = {}
          for (const field of ['childName', 'parentName', 'phone', 'email', 'comment'] as const)
            if (data[field] !== undefined) changes[field] = String(data[field])
          if (data.birthDate !== undefined) changes.birthDate = dateValue(data.birthDate as string)
          if (data.category !== undefined) changes.category = categoryValue(String(data.category))
          if (data.status !== undefined) changes.status = statusValue(String(data.status))
          if (data.lessonsPerWeek !== undefined) changes.lessonsPerWeek = Number(data.lessonsPerWeek)
          if (!Object.keys(changes).length) throw new PostgresApiError(400, 'VALIDATION', 'Нет изменяемых полей')
          await tx.client.update({ where: { id: client.id }, data: { ...changes, version: { increment: 1 } } })
          await audit('client', client.id, client.branchId, Object.keys(changes))
        }
        return { success: true }
      }
      if (action === 'createCoach') {
        await requireBranch(tx, data.branchId!)
        const user = password
          ? await tx.user.create({
              data: {
                name: String(data.name),
                username: String(data.username),
                role: 'coach',
                status: 'active',
                branchId: data.branchId,
              },
            })
          : null
        if (user)
          await tx.account.create({ data: { userId: user.id, accountId: user.id, providerId: 'credential', password } })
        const coach = await tx.coach.create({
          data: {
            name: String(data.name),
            specialty: String(data.specialty),
            branchId: data.branchId!,
            userId: user?.id,
            phone: String(data.phone || '') || null,
            birthDate: dateValue(data.birthDate as string | undefined),
            memberships: { create: { branchId: data.branchId! } },
          },
        })
        await audit('coach', coach.id, coach.branchId, [
          'name',
          'specialty',
          'branchId',
          ...(user ? ['userId', 'account.password'] : []),
        ])
        return coachDto(coach, canonical)
      }
      const coach = await tx.coach.findUnique({ where: { id: data.id } })
      if (!coach) throw new PostgresApiError(404, 'NOT_FOUND', 'Тренер не найден')
      if (coach.userId)
        await tx.user.update({
          where: { id: coach.userId },
          data: { status: 'disabled', disabledAt: new Date(), authVersion: { increment: 1 } },
        })
      if (coach.userId) await tx.session.deleteMany({ where: { userId: coach.userId } })
      await tx.coach.update({ where: { id: coach.id }, data: { archivedAt: new Date() } })
      await audit('coach', coach.id, coach.branchId, [
        'archivedAt',
        ...(coach.userId ? ['user.status', 'user.authVersion'] : []),
      ])
      return { success: true }
    },
    async (tx, _result, canonical) => {
      requireAdmin(canonical)
      if (action.startsWith('create')) {
        const entityId = await mutationEntity(tx, canonical, data.requestId)
        if (action === 'createBranch') return tx.branch.findUniqueOrThrow({ where: { id: entityId } })
        if (action === 'createClient') {
          const row = await tx.client.findUnique({ where: { id: entityId } })
          if (!row)
            throw new PostgresApiError(409, 'CONFLICT', 'Созданная карточка уже удалена; повтор не восстанавливает её')
          return clientDto(row, canonical)
        }
        const row = await tx.coach.findUniqueOrThrow({ where: { id: entityId } })
        if (row.archivedAt)
          throw new PostgresApiError(
            409,
            'CONFLICT',
            'Созданная карточка уже архивирована; повтор не восстанавливает её',
          )
        return coachDto(row, canonical)
      }
      return { success: true, duplicate: true }
    },
    { accountManagement: action === 'createCoach' || action === 'deleteCoach' },
  )
}

const pageInput = z
  .object({
    branchId: id.optional(),
    page: z.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.number().int().min(1).max(500).default(100),
    query: z.string().trim().max(100).optional(),
    status: status.optional(),
    sortBy: z.enum(['childName', 'paidAmount']).default('childName'),
    sortDir: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict()
export async function clientsPage(db: PrismaClient, actor: Actor, input: unknown) {
  const data = pageInput.parse(input)
  if (actor.role !== 'admin' && data.sortBy === 'paidAmount')
    throw new PostgresApiError(403, 'FORBIDDEN', 'Финансовая сортировка недоступна')
  const branchId = branchScope(actor, data.branchId)
  const where: Prisma.ClientWhereInput = {
    ...(branchId ? { branchId } : {}),
    ...(data.status ? { status: statusValue(data.status) } : {}),
    ...(data.query
      ? {
          OR: (actor.role === 'admin' ? ['childName', 'parentName', 'phone', 'email'] : ['childName']).map((field) => ({
            [field]: { contains: data.query, mode: 'insensitive' },
          })),
        }
      : {}),
  }
  return db.$transaction(
    async (tx) => {
      const total = await tx.client.count({ where })
      const rows = await tx.client.findMany({
        where,
        include:
          actor.role === 'admin'
            ? {
                _count: {
                  select: {
                    enrollments: true,
                    seriesEnrollments: true,
                    payments: true,
                    ledger: true,
                    documents: true,
                    documentUploads: true,
                  },
                },
              }
            : undefined,
        orderBy: [{ [data.sortBy === 'paidAmount' ? 'paidAmountMinor' : 'childName']: data.sortDir }, { id: 'asc' }],
        skip: (data.page - 1) * data.pageSize,
        take: data.pageSize,
      })
      return {
        items: rows.map((row) => clientDto(row, actor)),
        total,
        page: data.page,
        pageSize: data.pageSize,
        hasMore: data.page * data.pageSize < total,
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}
export async function catalogSheet(db: PrismaClient, actor: Actor, input: unknown) {
  const data = z
    .object({ sheet: z.enum(['Клиенты', 'Тренеры', 'Филиалы', 'Расписание']), branchId: id.optional() })
    .strict()
    .parse(input)
  const branchId = branchScope(actor, data.branchId)
  if (data.sheet === 'Расписание')
    throw new PostgresApiError(
      503,
      'SERVICE_UNAVAILABLE',
      'Полный модуль расписания ещё не подключён; обращения к GAS нет',
    )
  if (data.sheet === 'Филиалы')
    return db.branch.findMany({
      where: { archivedAt: null, ...(actor.role === 'coach' ? { id: branchId } : {}) },
      select: { id: true, name: true, address: true },
      orderBy: { name: 'asc' },
    })
  if (data.sheet === 'Тренеры')
    return (await db.coach.findMany({ where: { archivedAt: null, ...(branchId ? { branchId } : {}) } })).map((row) =>
      coachDto(row, actor),
    )
  const clients = await db.client.findMany({
    where: branchId ? { branchId } : {},
    include:
      actor.role === 'admin'
        ? {
            _count: {
              select: {
                enrollments: true,
                seriesEnrollments: true,
                payments: true,
                ledger: true,
                documents: true,
                documentUploads: true,
              },
            },
          }
        : undefined,
    take: 501,
    orderBy: [{ childName: 'asc' }, { id: 'asc' }],
  })
  if (clients.length > 500)
    throw new PostgresApiError(422, 'VALIDATION', 'Используйте getClients с пагинацией: список превышает 500 клиентов')
  return clients.map((row) => clientDto(row, actor))
}
export async function clientOptions(db: PrismaClient, actor: Actor, input: unknown) {
  const data = z
    .object({
      branchId: id.optional(),
      query: z.string().trim().max(100).optional(),
      category: category.optional(),
      limit: z.number().int().min(1).max(500).default(20),
    })
    .strict()
    .parse(input)
  const branchId = branchScope(actor, data.branchId)
  const items = await db.client.findMany({
    where: {
      status: 'active',
      ...(branchId ? { branchId } : {}),
      ...(data.category ? { category: categoryValue(data.category) } : {}),
      ...(data.query ? { childName: { contains: data.query, mode: 'insensitive' } } : {}),
    },
    orderBy: [{ childName: 'asc' }, { id: 'asc' }],
    take: data.limit,
  })
  return {
    items: items.map((row) => ({
      ...clientDto(row, actor),
      ...(actor.role === 'admin' ? { parentName: row.parentName } : {}),
    })),
  }
}
