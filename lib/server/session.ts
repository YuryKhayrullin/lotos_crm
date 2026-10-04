import 'server-only'

import { cookies } from 'next/headers'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { callGas, GasError } from './gas'

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

function getSessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32 || secret === 'insert_secret_key_here') {
    throw new SessionError('Сервис авторизации временно недоступен', 503)
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
  if (!token) return null

  try {
    const { payload } = await jwtVerify<SessionPayload>(token, getSessionSecret(), {
      algorithms: ['HS256'],
    })
    const normalized = normalizeUser(payload)
    if (!normalized || !options.revalidate) return normalized

    try {
      const response = (await callGas({ action: 'getCurrentUser', auth: normalized })) as Record<string, unknown>
      const currentUser = normalizeUser(response.user)
      if (!currentUser || currentUser.id !== normalized.id) return null
      return currentUser
    } catch (error) {
      if (error instanceof GasError && error.status === 503) throw error
      // Invalid or disabled authoritative accounts invalidate the local session.
      return null
    }
  } catch (error) {
    if ((error instanceof GasError || error instanceof SessionError) && error.status === 503) throw error
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
