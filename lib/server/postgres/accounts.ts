import 'server-only'
import { hashPassword } from 'better-auth/crypto'
import type { Prisma, PrismaClient } from '../../../.generated/prisma/client'
import { accountInputSchemas, bootstrapAdminSchema, registrationSchema, type AccountAction } from './auth-input'
import { lockActor, requireAdmin, type Actor } from './access'
import { PostgresApiError } from './errors'
import { authDigest } from './digest'
import { prepareMutationDraft, assertMutationDraftOpen } from './mutations'
export { authDigest } from './digest'

// A global lock is limited to rare account-management transactions. Domain
// attendance/payment transactions will use their own per-client locks.
async function managementLock(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('lotos-auth-management-v1', 0))`
}

export async function bootstrapAdmin(db: PrismaClient, input: unknown) {
  const data = bootstrapAdminSchema.parse(input)
  const password = await hashPassword(data.password)
  return db.$transaction(async (tx) => {
    await managementLock(tx)
    if (await tx.user.count({ where: { role: 'admin' } }))
      throw new PostgresApiError(409, 'CONFLICT', 'Первый администратор уже существует')
    const user = await tx.user.create({
      data: { name: data.name, username: data.username, role: 'admin', status: 'active' },
    })
    await tx.account.create({ data: { userId: user.id, accountId: user.id, providerId: 'credential', password } })
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        action: 'bootstrapAdmin',
        entityType: 'user',
        entityId: user.id,
        changedFields: ['username', 'role', 'status', 'password'],
        source: 'bootstrap-cli',
      },
    })
    return { id: user.id, username: user.username! }
  })
}

export async function registerPendingCoach(db: PrismaClient, input: unknown, secret: string) {
  const data = registrationSchema.parse(input)
  const key = authDigest(secret, 'registration-key', data.requestId)
  const fingerprint = authDigest(secret, 'registration-payload', { username: data.username, password: data.password })
  const password = await hashPassword(data.password)
  return db.$transaction(async (tx) => {
    await managementLock(tx)
    const existing = await tx.registrationAttempt.findUnique({ where: { key } })
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new PostgresApiError(409, 'CONFLICT', 'Этот requestId уже использован с другими данными')
      return { status: 'success', pending: true }
    }
    const user = await tx.user.create({
      data: { name: data.username, username: data.username, role: 'coach', status: 'pending' },
    })
    await tx.account.create({ data: { userId: user.id, accountId: user.id, providerId: 'credential', password } })
    await tx.registrationAttempt.create({ data: { key, fingerprint, userId: user.id } })
    await tx.auditEvent.create({
      data: {
        action: 'registerCoach',
        entityType: 'user',
        entityId: user.id,
        changedFields: ['username', 'role', 'status'],
        source: 'registration',
      },
    })
    return { status: 'success', pending: true }
  })
}

export async function mutateCoachAccount(
  db: PrismaClient,
  actor: Actor,
  action: AccountAction,
  input: unknown,
  secret: string,
) {
  requireAdmin(actor)
  const data: {
    userId: string
    requestId: string
    auditReason?: string
    branchId?: string
    coachId?: string
    newPassword?: string
  } = accountInputSchemas[action].parse(input)
  // Explicit canonical semantic fields. A randomized credential hash is never
  // used as fingerprint; HMAC prevents an offline plaintext dictionary oracle.
  const fingerprint = authDigest(secret, 'account-mutation', {
    action,
    userId: data.userId,
    auditReason: data.auditReason || '',
    branchId: data.branchId || null,
    coachId: data.coachId || null,
    newPassword: data.newPassword || null,
  })
  const password = data.newPassword ? await hashPassword(data.newPassword) : null
  await prepareMutationDraft(db, actor, action, data.requestId, data, fingerprint)
  return db.$transaction(async (tx) => {
    await managementLock(tx)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id + ':' + data.requestId}, 0))`
    const canonical = await lockActor(tx, actor)
    requireAdmin(canonical)
    const previous = await tx.mutationRequest.findUnique({
      where: { actorId_requestKey: { actorId: actor.id, requestKey: data.requestId } },
    })
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.action !== action)
        throw new PostgresApiError(409, 'CONFLICT', 'Этот requestId уже использован с другими данными')
      return { success: true, duplicate: true }
    }
    await assertMutationDraftOpen(tx, actor, data.requestId)
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${data.userId} FOR UPDATE`
    const user = await tx.user.findUnique({ where: { id: data.userId }, include: { coach: true, branch: true } })
    if (!user) throw new PostgresApiError(404, 'NOT_FOUND', 'Аккаунт не найден')
    if (user.role !== 'coach') throw new PostgresApiError(403, 'FORBIDDEN', 'Управлять можно только аккаунтом тренера')
    const changed: string[] = []
    let revoke = false
    if (action === 'assignUserBranch' && data.branchId) {
      const branch = await tx.branch.findUnique({ where: { id: data.branchId } })
      if (!branch || branch.archivedAt) throw new PostgresApiError(404, 'NOT_FOUND', 'Филиал не найден')
      if (user.coach) {
        const coach = user.coach
        if (coach.branchId !== branch.id) {
          await tx.coachBranch.upsert({
            where: { coachId_branchId: { coachId: coach.id, branchId: coach.branchId } },
            create: { coachId: coach.id, branchId: coach.branchId, assignedAt: coach.createdAt, endedAt: new Date() },
            update: { endedAt: new Date() },
          })
          await tx.coach.update({ where: { id: coach.id }, data: { branchId: branch.id } })
          changed.push('coach.branchId')
        }
        await tx.coachBranch.upsert({
          where: { coachId_branchId: { coachId: coach.id, branchId: branch.id } },
          create: { coachId: coach.id, branchId: branch.id },
          update: { endedAt: null },
        })
      }
      if (user.branchId !== branch.id) {
        await tx.user.update({ where: { id: user.id }, data: { branchId: branch.id } })
        changed.push('branchId')
      }
      revoke = changed.length > 0
    } else if (action === 'activateUser') {
      if (user.coach?.archivedAt)
        throw new PostgresApiError(409, 'CONFLICT', 'Карточка тренера в архиве; сначала согласуйте её восстановление')
      if (!user.branch || user.branch.archivedAt)
        throw new PostgresApiError(403, 'FORBIDDEN', 'Сначала назначьте действующий филиал')
      if (user.coach && user.coach.branchId !== user.branchId)
        throw new PostgresApiError(409, 'CONFLICT', 'Сначала согласуйте филиал карточки и аккаунта')
      if (user.status !== 'active') {
        await tx.user.update({ where: { id: user.id }, data: { status: 'active', disabledAt: null } })
        changed.push('status', 'disabledAt')
        revoke = true
      }
    } else if (action === 'deactivateUser') {
      if (user.status !== 'disabled') {
        await tx.user.update({ where: { id: user.id }, data: { status: 'disabled', disabledAt: new Date() } })
        changed.push('status', 'disabledAt')
        revoke = true
      }
    } else if (action === 'resetCoachPassword' && password) {
      await tx.account.upsert({
        where: { providerId_accountId: { providerId: 'credential', accountId: user.id } },
        create: { userId: user.id, accountId: user.id, providerId: 'credential', password },
        update: { password },
      })
      changed.push('password')
      revoke = true
    } else if (action === 'revokeUserSessions') {
      revoke = true
    } else if (action === 'linkCoachUser' && data.coachId) {
      const coach = await tx.coach.findUnique({ where: { id: data.coachId } })
      if (!coach || coach.archivedAt) throw new PostgresApiError(404, 'NOT_FOUND', 'Карточка тренера не найдена')
      if (!user.branchId || coach.branchId !== user.branchId)
        throw new PostgresApiError(403, 'FORBIDDEN', 'Карточка и аккаунт должны относиться к одному филиалу')
      if ((coach.userId && coach.userId !== user.id) || (user.coach && user.coach.id !== coach.id))
        throw new PostgresApiError(409, 'CONFLICT', 'Карточка или аккаунт уже связаны')
      await tx.coachBranch.upsert({
        where: { coachId_branchId: { coachId: coach.id, branchId: coach.branchId } },
        create: { coachId: coach.id, branchId: coach.branchId },
        update: {},
      })
      if (coach.userId !== user.id) {
        await tx.coach.update({ where: { id: coach.id }, data: { userId: user.id } })
        changed.push('coach.userId')
        revoke = true
      }
    }
    if (revoke) {
      await tx.user.update({ where: { id: user.id }, data: { authVersion: { increment: 1 } } })
      await tx.session.deleteMany({ where: { userId: user.id } })
      changed.push('authVersion')
    }
    const marker = await tx.mutationRequest.create({
      data: { actorId: actor.id, requestKey: data.requestId, action, fingerprint, result: { success: true } },
    })
    if (changed.length)
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          requestId: marker.id,
          action,
          entityType: 'user',
          entityId: user.id,
          branchId: data.branchId || user.branchId,
          changedFields: changed,
          reason: data.auditReason || null,
        },
      })
    return { success: true }
  })
}

export async function coachAccounts(db: PrismaClient) {
  const users = await db.user.findMany({
    where: { role: 'coach' },
    orderBy: { username: 'asc' },
    select: {
      id: true,
      username: true,
      branchId: true,
      status: true,
      disabledAt: true,
      coach: { select: { archivedAt: true } },
    },
  })
  const disables = await db.auditEvent.findMany({
    where: { action: 'deactivateUser', entityType: 'user', entityId: { in: users.map((user) => user.id) } },
    orderBy: { createdAt: 'desc' },
    select: { entityId: true, actor: { select: { username: true } } },
  })
  return users.map((user) => ({
    id: user.id,
    username: user.username || '',
    role: 'coach',
    branchId: user.branchId,
    status: { pending: 'Ожидает подтверждения', active: 'Активен', disabled: 'Отключен' }[user.status],
    disabledAt: user.disabledAt?.toISOString() || null,
    disabledBy:
      user.status === 'disabled' ? disables.find((entry) => entry.entityId === user.id)?.actor?.username || null : null,
    canRevokeSessions: true,
    profileArchived: Boolean(user.coach?.archivedAt),
  }))
}
