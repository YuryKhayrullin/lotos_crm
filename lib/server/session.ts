import 'server-only'

import { cookies } from 'next/headers'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { callGas } from './gas'

export type SessionRole = 'admin' | 'coach'

export type SessionUser = {
  id: string
  username: string
  role: SessionRole
  branchId: string | null
}

type SessionPayload = JWTPayload & SessionUser

export const SESSION_COOKIE = 'lotos_crm_session'
const SESSION_TTL_SECONDS = 60 * 60 * 8
function sessionLog(event: string, details: Record<string, unknown> = {}): void {
  console.log('[lotos-session] ' + event, details)
}

function getSessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32 || secret === 'insert_secret_key_here') {
    throw new Error('SESSION_SECRET is missing or too short (minimum 32 characters)')
  }
  return new TextEncoder().encode(secret)
}

function normalizeUser(value: unknown): SessionUser | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const roleValue = String(source.role ?? '').toLowerCase()
  if (roleValue !== 'admin' && roleValue !== 'coach' && roleValue !== '1' && roleValue !== '2') return null
  const id = String(source.id ?? '')
  const username = String(source.username ?? '').trim()
  if (!id || !username) return null
  return {
    id,
    username,
    role: roleValue === 'admin' || roleValue === '1' ? 'admin' : 'coach',
    branchId:
      source.branchId === null || source.branchId === undefined || source.branchId === ''
        ? null
        : String(source.branchId),
  }
}

export async function createSession(user: unknown): Promise<SessionUser> {
  const normalized = normalizeUser(user)
  if (!normalized) throw new Error('Invalid authenticated user')

  const token = await new SignJWT(normalized)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(normalized.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSessionSecret())

  const store = await cookies()
  store.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })

  return normalized
}

export async function getSession(options: { revalidate?: boolean } = {}): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  sessionLog('read', { hasCookie: Boolean(token), revalidate: Boolean(options.revalidate) })
  if (!token) return null

  try {
    const { payload } = await jwtVerify<SessionPayload>(token, getSessionSecret(), {
      algorithms: ['HS256'],
    })
    const normalized = normalizeUser(payload)
    if (!normalized || !options.revalidate) {
      sessionLog('jwt.valid', { revalidate: false, userId: normalized?.id ?? null, role: normalized?.role ?? null })
      return normalized
    }

    try {
      sessionLog('revalidate.start', { userId: normalized.id, role: normalized.role })
      const response = (await callGas({ action: 'getCurrentUser', auth: normalized })) as Record<string, unknown>
      const currentUser = normalizeUser(response.user)
      if (!currentUser || currentUser.id !== normalized.id) {
        sessionLog('revalidate.mismatch', { userId: normalized.id, hasCurrentUser: Boolean(currentUser) })
        return null
      }
      sessionLog('revalidate.ok', { userId: currentUser.id, role: currentUser.role })
      return currentUser
    } catch (error) {
      sessionLog('revalidate.failed', {
        userId: normalized.id,
        reason: error instanceof Error ? error.message : String(error),
      })
      // Fail closed for protected requests if the authoritative user store is unavailable.
      return null
    }
  } catch {
    return null
  }
}

export async function requireSession(): Promise<SessionUser> {
  const user = await getSession()
  if (!user) throw new SessionError('Требуется авторизация', 401)
  return user
}

export async function clearSession(): Promise<void> {
  const store = await cookies()
  store.set({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  })
}

export class SessionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'SessionError'
  }
}
