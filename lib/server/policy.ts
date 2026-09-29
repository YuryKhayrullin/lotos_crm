import type { SessionUser } from './session'

const ADMIN_ONLY = new Set([
  'createUser',
  'getUsers',
  'assignUserBranch',
  'createBranch',
  'createCoach',
  'updateCoach',
  'deleteCoach',
  'uploadReceipt',
  'getReceipt',
  'getClientHistory',
  'recordPayment',
  'addLessons',
  'createClient',
  'updateClient',
  'deleteClient',
])

const COACH_ALLOWED = new Set([
  'getSheet',
  'getClients',
  'createLesson',
  'updateLesson',
  'deleteLesson',
  'recordAttendance',
  'recordBulkAttendance',
])

const KNOWN_ACTIONS = new Set([
  'createUser',
  'getUsers',
  'assignUserBranch',
  'getSheet',
  'getClients',
  'createBranch',
  'createCoach',
  'updateCoach',
  'deleteCoach',
  'uploadReceipt',
  'getReceipt',
  'getClientHistory',
  'recordPayment',
  'addLessons',
  'createClient',
  'updateClient',
  'deleteClient',
  'createLesson',
  'updateLesson',
  'deleteLesson',
  'recordAttendance',
  'recordBulkAttendance',
])

export function assertActionAllowed(action: string, user: SessionUser): void {
  if (!action || action.length > 64) throw new PolicyError('Недопустимое действие', 400)
  if (!KNOWN_ACTIONS.has(action)) throw new PolicyError('Недопустимое действие', 400)
  if (ADMIN_ONLY.has(action) && user.role !== 'admin') {
    throw new PolicyError('Недостаточно прав', 403)
  }
  if (user.role === 'coach' && !COACH_ALLOWED.has(action)) {
    throw new PolicyError('Недостаточно прав', 403)
  }
}

export function withBranchScope(payload: Record<string, unknown>, user: SessionUser): Record<string, unknown> {
  if (user.role !== 'coach') return { ...payload }
  if (!user.branchId) throw new PolicyError('У пользователя не назначен филиал', 403)
  return { ...payload, branchId: user.branchId }
}

export class PolicyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'PolicyError'
  }
}
