import 'server-only'
import type { Prisma, PrismaClient } from '../../../.generated/prisma/client'
import { authorizeAction, lockActor, type Actor } from './access'
import { authDigest } from './digest'
import { PostgresApiError } from './errors'

export const recoverableActions = new Set([
  'createClient',
  'createLesson',
  'createLessonWithClients',
  'recordPayment',
  'recordAdjustment',
  'createBranch',
  'createCoach',
  'updateClient',
  'deleteClient',
  'deleteCoach',
  'updateLesson',
  'cancelLesson',
  'deleteLesson',
  'assignClientLesson',
  'repairLessonLedger',
  'assignUserBranch',
  'deactivateUser',
  'activateUser',
  'resetCoachPassword',
  'revokeUserSessions',
  'linkCoachUser',
])

export async function prepareMutationDraft(
  db: PrismaClient,
  actor: Actor,
  action: string,
  requestKey: string,
  payload: unknown,
  fingerprint: string,
) {
  const safePayload = { ...(payload as Record<string, unknown>) }
  const requiresCredential = typeof safePayload.password === 'string' || typeof safePayload.newPassword === 'string'
  delete safePayload.password
  delete safePayload.newPassword
  delete safePayload.passwordHash
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id + ':' + requestKey}, 0))`
    authorizeAction(action, await lockActor(tx, actor))
    const previous = await tx.mutationDraft.findUnique({
      where: { actorId_requestKey: { actorId: actor.id, requestKey } },
    })
    if (previous) {
      if (previous.action !== action || previous.fingerprint !== fingerprint)
        throw new PostgresApiError(409, 'CONFLICT', 'Этот requestId уже использован с другими данными')
      if (
        previous.state === 'closed' &&
        !(await tx.mutationRequest.findUnique({ where: { actorId_requestKey: { actorId: actor.id, requestKey } } }))
      )
        throw new PostgresApiError(409, 'CONFLICT', 'Попытка закрыта. Новая операция требует нового ключа')
      return
    }
    await tx.mutationDraft.create({
      data: {
        actorId: actor.id,
        requestKey,
        action,
        fingerprint,
        requiresCredential,
        payload: safePayload as Prisma.InputJsonValue,
      },
    })
  })
}

export async function assertMutationDraftOpen(tx: Prisma.TransactionClient, actor: Actor, requestKey: string) {
  const draft = await tx.mutationDraft.findUnique({ where: { actorId_requestKey: { actorId: actor.id, requestKey } } })
  if (!draft || draft.state !== 'pending') throw new PostgresApiError(409, 'CONFLICT', 'Попытка уже закрыта')
}

export async function mutationDrafts(db: PrismaClient, actor: Actor) {
  const rows = await db.mutationDraft.findMany({
    where: {
      actorId: actor.id,
      state: 'pending',
      ...(actor.role === 'coach'
        ? { action: { in: ['createLesson', 'createLessonWithClients', 'updateLesson', 'cancelLesson'] } }
        : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: 21,
  })
  const markers = await db.mutationRequest.findMany({
    where: { actorId: actor.id, requestKey: { in: rows.map((row) => row.requestKey) } },
    select: { requestKey: true },
  })
  const confirmed = new Set(markers.map((row) => row.requestKey))
  // No pupil data, payment amounts or private payload is returned by the inbox.
  return {
    items: rows.slice(0, 20).map((row) => ({
      requestId: row.requestKey,
      action: row.action,
      confirmed: confirmed.has(row.requestKey),
      requiresCredential: row.requiresCredential,
      createdAt: row.createdAt.toISOString(),
    })),
    hasMore: rows.length > 20,
  }
}

export async function closeMutationDraft(db: PrismaClient, actor: Actor, requestKey: string, acknowledgeOnly = false) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id + ':' + requestKey}, 0))`
    const canonical = await lockActor(tx, actor)
    const draft = await tx.mutationDraft.findUnique({
      where: { actorId_requestKey: { actorId: actor.id, requestKey } },
    })
    if (!draft) throw new PostgresApiError(404, 'NOT_FOUND', 'Попытка не найдена')
    authorizeAction(draft.action, canonical)
    const marker = await tx.mutationRequest.findUnique({
      where: { actorId_requestKey: { actorId: actor.id, requestKey } },
    })
    if (acknowledgeOnly && !marker) throw new PostgresApiError(409, 'CONFLICT', 'Операция ещё не подтверждена')
    await tx.mutationDraft.update({
      where: { id: draft.id },
      data: { state: marker ? 'acknowledged' : 'closed', payload: {} },
    })
    if (draft.state === 'pending')
      await tx.auditEvent.create({
        data: {
          actorId: canonical.id,
          action: marker ? 'acknowledgeMutation' : 'closeMutationAttempt',
          entityType: 'mutationDraft',
          entityId: draft.id,
          changedFields: ['state'],
        },
      })
    return { success: true, confirmed: Boolean(marker) }
  })
}

export async function domainMutation<T>(
  db: PrismaClient,
  actor: Actor,
  action: string,
  requestKey: string,
  payload: unknown,
  secret: string,
  write: (tx: Prisma.TransactionClient, actor: Actor, requestId: string) => Promise<T>,
  resolve: (tx: Prisma.TransactionClient, result: Prisma.JsonValue, actor: Actor) => Promise<T>,
  options: { accountManagement?: boolean; timeout?: number } = {},
) {
  const fingerprint = authDigest(secret, 'domain-mutation', { action, payload })
  if (recoverableActions.has(action)) await prepareMutationDraft(db, actor, action, requestKey, payload, fingerprint)
  return db.$transaction(
    async (tx) => {
      // Match account-management lock order BEFORE locking actor/target rows.
      // Otherwise a rejected operation targeting an admin can deadlock against
      // concurrent profile creation waiting for this same advisory lock.
      if (options.accountManagement)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('lotos-auth-management-v1', 0))`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id + ':' + requestKey}, 0))`
      const canonical = await lockActor(tx, actor)
      const previous = await tx.mutationRequest.findUnique({
        where: { actorId_requestKey: { actorId: actor.id, requestKey } },
      })
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.action !== action)
          throw new PostgresApiError(409, 'CONFLICT', 'Этот requestId уже использован с другими данными')
        return resolve(tx, previous.result, canonical)
      }
      if (recoverableActions.has(action)) {
        await assertMutationDraftOpen(tx, actor, requestKey)
      }
      // Insert the confirmation before child rows only INSIDE the transaction;
      // no failed/in-progress result can escape a rollback or become a replay.
      const marker = await tx.mutationRequest.create({
        data: { actorId: actor.id, requestKey, action, fingerprint, result: {} },
      })
      const result = await write(tx, canonical, marker.id)
      // Immutable markers cannot be updated. Store the reference in an audit
      // child instead; resolver identifies the entity through this request ID.
      return result
    },
    { timeout: options.timeout || 10_000, maxWait: 10_000 },
  )
}

export async function mutationEntity(tx: Prisma.TransactionClient, actor: Actor, requestKey: string) {
  const marker = await tx.mutationRequest.findUniqueOrThrow({
    where: { actorId_requestKey: { actorId: actor.id, requestKey } },
  })
  const event = await tx.auditEvent.findFirst({ where: { requestId: marker.id }, orderBy: { createdAt: 'asc' } })
  if (!event) throw new PostgresApiError(409, 'CONFLICT', 'Подтверждение операции требует проверки')
  return event.entityId
}
