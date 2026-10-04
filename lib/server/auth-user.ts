export type ActiveAuthUser = {
  id: string
  username: string
  passwordHash: string
  role: 'admin' | 'coach' | '1' | '2'
  branchId: string | null
  status: 'Активен'
}

/**
 * The login boundary accepts only a complete, currently active GAS user.
 * Disabled users still go through password verification for comparable timing,
 * but this predicate prevents a session from being created for them.
 */
export function isActiveAuthUser(value: unknown): value is ActiveAuthUser {
  if (!value || typeof value !== 'object') return false
  const user = value as Record<string, unknown>
  return (
    typeof user.id === 'string' &&
    typeof user.username === 'string' &&
    typeof user.passwordHash === 'string' &&
    ['admin', 'coach', '1', '2'].includes(String(user.role)) &&
    user.status === 'Активен'
  )
}
