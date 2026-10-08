import 'server-only'
import type { Prisma, PrismaClient } from '../../../.generated/prisma/client'
import type { createPostgresAuth } from './auth'
import { PostgresApiError } from './errors'

export type PostgresAuth = ReturnType<typeof createPostgresAuth>
export type Actor = {
  id: string
  username: string
  role: 'admin' | 'coach'
  branchId: string | null
  sessionId: string
  authVersion: number
}

export async function validateActor(
  db: PrismaClient | Prisma.TransactionClient,
  identity: { id: string; sessionId: string },
): Promise<Actor> {
  const session = await db.session.findUnique({
    where: { id: identity.sessionId },
    include: { user: { include: { branch: true } } },
  })
  const user = session?.user
  if (
    !session ||
    !user ||
    user.id !== identity.id ||
    session.expiresAt <= new Date() ||
    user.status !== 'active' ||
    !user.username ||
    session.authVersion !== user.authVersion
  )
    throw new PostgresApiError(401, 'UNAUTHORIZED', 'Требуется авторизация')
  if (user.role === 'coach' && (!user.branch || user.branch.archivedAt))
    throw new PostgresApiError(403, 'FORBIDDEN', 'Аккаунту не назначен действующий филиал')
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    branchId: user.branchId,
    sessionId: session.id,
    authVersion: user.authVersion,
  }
}

export async function requireActor(db: PrismaClient, auth: PostgresAuth, headers: Headers): Promise<Actor> {
  const resolved = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } })
  if (!resolved) throw new PostgresApiError(401, 'UNAUTHORIZED', 'Требуется авторизация')
  // The signed cookie resolves an identity, NOT permission. Re-read canonical
  // state, including the session row, to reject refresh/revocation races.
  return validateActor(db, { id: resolved.user.id, sessionId: resolved.session.id })
}

export async function lockActor(tx: Prisma.TransactionClient, actor: Actor) {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR SHARE`
  return validateActor(tx, actor)
}

export function requireAdmin(actor: Actor) {
  if (actor.role !== 'admin') throw new PostgresApiError(403, 'FORBIDDEN', 'Недостаточно прав')
}

export function apiUser(actor: Actor) {
  return { id: actor.id, username: actor.username, role: actor.role, branchId: actor.branchId }
}

const adminOnly = new Set([
  'getUsers',
  'assignUserBranch',
  'deactivateUser',
  'activateUser',
  'resetCoachPassword',
  'revokeUserSessions',
  'linkCoachUser',
  'createBranch',
  'createCoach',
  'deleteCoach',
  'createClient',
  'updateClient',
  'deleteClient',
  'assignClientLesson',
  'recordPayment',
  'recordAdjustment',
  'auditLessonLedger',
  'repairLessonLedger',
  'uploadReceipt',
  'getReceipt',
  'getClientHistory',
  'getFinanceSummary',
  'getSubscriptionsPage',
])
const coachActions = new Set([
  'getCurrentUser',
  'getBootstrapData',
  'getSheet',
  'getClients',
  'getDashboardSummary',
  'searchClientOptions',
  'getLessonRoster',
  'recordAttendance',
  'recordBulkAttendance',
  'createLesson',
  'createLessonWithClients',
  'getSchedule',
  'prepareAttendance',
  'acknowledgeAttendance',
])
const laterActions = new Set(['updateLesson', 'cancelLesson', 'deleteLesson'])

export function authorizeAction(action: string, actor: Actor) {
  if (!adminOnly.has(action) && !coachActions.has(action) && !laterActions.has(action))
    throw new PostgresApiError(400, 'VALIDATION', 'Недопустимое действие')
  if (actor.role === 'admin') return
  if (adminOnly.has(action) || action === 'deleteLesson') requireAdmin(actor)
  // Specific edit/cancel ownership is checked against the assigned profile
  // inside the schedule transaction; attendance keeps whole-branch scope.
}

export function branchScope(actor: Actor, requested: string | undefined) {
  return actor.role === 'coach' ? actor.branchId! : requested
}
