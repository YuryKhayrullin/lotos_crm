import { NextRequest, NextResponse } from 'next/server'
import { isActiveAuthUser } from '@/lib/server/auth-user'
import { callGas, GasError } from '@/lib/server/gas'
import { codeForHttpStatus, type PublicApiErrorCode } from '@/lib/server/api-errors'
import { dispatchCrmAction, UPLOAD_ACTIONS } from '@/lib/server/crm-router'
import { serverLog } from '@/lib/server/logger'
import { PolicyError } from '@/lib/server/policy'
import { rejectCrossOrigin } from '@/lib/server/request'
import {
  getLoginRateLimiter,
  getRegistrationRateLimiter,
  LoginRateLimitUnavailableError,
} from '@/lib/server/login-rate-limit'
import { assertPasswordPolicy, hashPassword, isScryptPasswordHash, verifyPassword } from '@/lib/server/passwords'
import { clearSession, createSession, getSession, SessionError } from '@/lib/server/session'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ path?: string[] }> }
type JsonRecord = Record<string, unknown>
type HttpMethod = 'GET' | 'POST'
type RouteValues = { clientId?: string }
type RouteHandler = (request: NextRequest, values: RouteValues) => Promise<Response>
type RouteDefinition = {
  name: string
  method: HttpMethod
  match: (segments: string[]) => RouteValues | null
  handle: RouteHandler
}

const MAX_REQUEST_BYTES = 8 * 1024 * 1024
const MAX_STANDARD_BYTES = 512 * 1024
const MAX_AUTH_BYTES = 16 * 1024
const MAX_RECEIPT_BASE64_BYTES = 7 * 1024 * 1024
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024
const SAFE_RECEIPT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf'])

class RouteError extends Error {
  constructor(
    public readonly publicMessage: string,
    public readonly status: number,
    public readonly code: PublicApiErrorCode = codeForHttpStatus(status),
  ) {
    super(publicMessage)
    this.name = 'RouteError'
  }
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

function jsonError(
  message: string,
  status: number,
  code: PublicApiErrorCode = codeForHttpStatus(status),
): NextResponse {
  return jsonResponse({ status: 'error', code, message }, status)
}

function bodySize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

async function readJson(request: Request, maxBytes: number): Promise<JsonRecord> {
  const declaredLength = Number(request.headers.get('content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RouteError('Запрос слишком большой', 413)
  }

  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new RouteError('Некорректный JSON в запросе', 400)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RouteError('Тело запроса должно быть JSON-объектом', 400)
  }
  if (bodySize(value) > maxBytes) throw new RouteError('Запрос слишком большой', 413)
  return value as JsonRecord
}

function safePayload(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...(value as JsonRecord) }
}

function requiredText(value: unknown, max: number, trim = true): string {
  const raw = typeof value === 'string' ? value : ''
  const result = trim ? raw.trim() : raw
  if (!result || result.length > max) throw new RouteError('Некорректные данные входа', 400)
  return result
}

function authPayload(user: NonNullable<Awaited<ReturnType<typeof getSession>>>): JsonRecord {
  return { id: user.id, username: user.username, role: user.role, branchId: user.branchId }
}

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim().slice(0, 128)
  return (request.headers.get('x-real-ip') || 'unknown').trim().slice(0, 128) || 'unknown'
}

let dummyPasswordHash: Promise<string> | null = null
function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHash ??= hashPassword('not-a-real-password-for-timing-equalization')
  return dummyPasswordHash
}

async function handleLogin(request: NextRequest): Promise<Response> {
  const body = await readJson(request, MAX_AUTH_BYTES)
  const username = requiredText(body.username, 100)
  const password = requiredText(body.password, 200, false)
  const limiter = getLoginRateLimiter()
  const attempt = await limiter.check(clientIp(request), username)
  if (!attempt) throw new RouteError('Неверный логин или пароль', 401)

  const response = (await callGas({ action: 'getAuthUser', payload: { username } })) as JsonRecord
  const candidate = response.user
  const passwordHash =
    candidate && typeof candidate === 'object' && isScryptPasswordHash((candidate as JsonRecord).passwordHash)
      ? String((candidate as JsonRecord).passwordHash)
      : await getDummyPasswordHash()
  const passwordValid = await verifyPassword(password, passwordHash)
  if (!isActiveAuthUser(candidate) || !passwordValid) {
    throw new RouteError('Неверный логин или пароль', 401)
  }
  await limiter.resetSuccessfulPair(attempt)

  const isCoach = ['coach', '2'].includes(candidate.role)
  if (isCoach && (candidate.branchId === null || candidate.branchId === undefined || candidate.branchId === '')) {
    return jsonError('Аккаунт ожидает назначения филиала администратором', 403, 'FORBIDDEN')
  }
  const user = await createSession(candidate)
  return jsonResponse({ status: 'success', user })
}

async function handleLogout(): Promise<Response> {
  await clearSession()
  return jsonResponse({ status: 'success' })
}

async function handleRegister(request: NextRequest): Promise<Response> {
  const body = await readJson(request, MAX_AUTH_BYTES)
  const username = requiredText(body.username, 64).toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) {
    throw new RouteError(
      'Логин: 3–64 латинских буквы, цифры, точка, дефис или подчёркивание; начните с буквы или цифры',
      400,
    )
  }
  const password = requiredText(body.password, 200, false)
  const requestId = requiredText(body.requestId, 150)
  try {
    assertPasswordPolicy(password)
  } catch {
    throw new RouteError('Пароль должен содержать от 8 до 200 символов', 400)
  }
  if (!(await getRegistrationRateLimiter().check(clientIp(request), username))) {
    return jsonResponse(
      {
        status: 'error',
        code: 'RATE_LIMITED',
        message: 'Слишком много попыток регистрации. Повторите через 15 минут.',
      },
      429,
      { 'Retry-After': '900' },
    )
  }
  // Ignore ALL browser-supplied roles, branches, statuses and password hashes.
  // No session is issued, even when the browser already has an admin cookie.
  const result = (await callGas({
    action: 'registerCoach',
    payload: { username, passwordHash: await hashPassword(password), requestId },
  })) as JsonRecord | null
  if (!result || result.status !== 'success' || result.pending !== true) {
    throw new RouteError('Не удалось подтвердить регистрацию. Повторите тот же запрос.', 503)
  }
  return jsonResponse({ status: 'success', pending: true })
}

async function handleSession(): Promise<Response> {
  const user = await getSession({ revalidate: true })
  if (!user) {
    await clearSession()
    return jsonResponse(
      { status: 'error', code: 'UNAUTHORIZED', message: 'Требуется авторизация', authenticated: false, user: null },
      401,
    )
  }
  return jsonResponse({ authenticated: Boolean(user), user })
}

async function handleCrm(request: NextRequest): Promise<Response> {
  const body = await readJson(request, MAX_REQUEST_BYTES)
  const action = typeof body.action === 'string' ? body.action : ''
  if (!action || action === 'login') {
    throw new RouteError('Используйте endpoint авторизации', 400)
  }

  const payload = safePayload(body.payload)
  if (!UPLOAD_ACTIONS.has(action) && bodySize(payload) > MAX_STANDARD_BYTES) {
    throw new RouteError('Запрос слишком большой', 413)
  }
  const user = await getSession()
  if (!user) {
    throw new RouteError('Требуется авторизация', 401)
  }

  const startedAt = performance.now()
  // Every request reaches authoritative GAS authorization. Do not serve private
  // results from a process-local cache: another worker cannot invalidate it.
  // GAS still caches reference data AFTER checking the current Users row.
  const result = await dispatchCrmAction({ action, payload, user })
  return jsonResponse(result, 200, {
    'X-CRM-Cache': 'BYPASS',
    'Server-Timing': `crm;dur=${Math.max(0, Math.round(performance.now() - startedAt))}`,
  })
}

async function handleReceipt(_request: NextRequest, values: RouteValues): Promise<Response> {
  const clientId = values.clientId ?? ''
  if (!clientId || clientId.length > 100) throw new RouteError('Некорректный clientId', 400)

  const user = await getSession()
  if (!user) throw new RouteError('Требуется авторизация', 401)
  if (user.role !== 'admin') throw new RouteError('Недостаточно прав', 403)

  const result = (await callGas({
    action: 'getReceipt',
    payload: { clientId },
    auth: authPayload(user),
  })) as { base64?: string; mimeType?: string; fileName?: string }
  if (!result.base64) throw new RouteError('Квитанция не найдена', 404)
  if (result.base64.length > MAX_RECEIPT_BASE64_BYTES) throw new RouteError('Квитанция слишком большая', 413)

  const bytes = Buffer.from(result.base64, 'base64')
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new RouteError('Квитанция слишком большая', 413)
  const sourceMime = String(result.mimeType || '')
  const safeMime = SAFE_RECEIPT_MIME_TYPES.has(sourceMime) ? sourceMime : 'application/octet-stream'
  const disposition = SAFE_RECEIPT_MIME_TYPES.has(sourceMime) ? 'inline' : 'attachment'
  const filename = encodeURIComponent(result.fileName || 'receipt')
  return new Response(bytes, {
    headers: {
      'Content-Type': safeMime,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `${disposition}; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function exactRoute(...expected: string[]): RouteDefinition['match'] {
  return (segments) =>
    segments.length === expected.length && segments.every((segment, index) => segment === expected[index]) ? {} : null
}

const ROUTES: RouteDefinition[] = [
  { name: 'auth.session', method: 'GET', match: exactRoute('auth', 'session'), handle: handleSession },
  {
    name: 'receipts.get',
    method: 'GET',
    match: (segments) => (segments.length === 2 && segments[0] === 'receipts' ? { clientId: segments[1] } : null),
    handle: handleReceipt,
  },
  { name: 'auth.login', method: 'POST', match: exactRoute('auth', 'login'), handle: handleLogin },
  { name: 'auth.register', method: 'POST', match: exactRoute('auth', 'register'), handle: handleRegister },
  { name: 'auth.logout', method: 'POST', match: exactRoute('auth', 'logout'), handle: handleLogout },
  { name: 'crm', method: 'POST', match: exactRoute('crm'), handle: handleCrm },
]

function errorResponse(error: unknown, method: HttpMethod, route: string): NextResponse {
  if (error instanceof LoginRateLimitUnavailableError) {
    serverLog('warn', 'api.request.failed', { method, route, code: 'SERVICE_UNAVAILABLE', status: 503 })
    return jsonError(
      route === 'auth.register' ? 'Регистрация временно недоступна' : 'Вход временно недоступен',
      503,
      'SERVICE_UNAVAILABLE',
    )
  }
  if (error instanceof GasError) {
    serverLog('warn', 'api.request.failed', { method, route, code: error.code, status: error.status })
    return jsonError(error.publicMessage, error.status, error.code)
  }
  if (error instanceof RouteError) {
    serverLog('warn', 'api.request.failed', { method, route, code: error.code, status: error.status })
    return jsonError(error.publicMessage, error.status, error.code)
  }
  if (error instanceof SessionError) {
    const code = codeForHttpStatus(error.status)
    serverLog('warn', 'api.request.failed', { method, route, code, status: error.status })
    return jsonError(error.message, error.status, code)
  }
  if (error instanceof PolicyError) {
    const code = codeForHttpStatus(error.status)
    serverLog('warn', 'api.request.failed', { method, route, code, status: error.status })
    return jsonError(error.message, error.status, code)
  }
  serverLog('error', 'api.request.failed', { method, route, code: 'INTERNAL', status: 500 })
  return jsonError('Внутренняя ошибка сервера', 500, 'INTERNAL')
}

async function dispatchRequest(method: HttpMethod, request: NextRequest, context: RouteContext): Promise<Response> {
  let routeName = 'unmatched'
  try {
    const segments = (await context.params).path ?? []
    const backend = process.env.CRM_BACKEND || 'gas'
    if (backend === 'postgres') {
      const { dispatchPostgresRequest } = await import('@/lib/server/postgres/runtime')
      return dispatchPostgresRequest(request, segments)
    }
    if (backend !== 'gas') throw new RouteError('Некорректная конфигурация backend', 503, 'SERVICE_UNAVAILABLE')
    const matchingRoutes = ROUTES.filter((candidate) => candidate.match(segments) !== null)
    const route = matchingRoutes.find((candidate) => candidate.method === method)
    if (!route) {
      if (matchingRoutes.length === 0) return jsonError('Маршрут не найден', 404, 'NOT_FOUND')
      const allow = [...new Set(matchingRoutes.map((candidate) => candidate.method))].join(', ')
      return new NextResponse(
        JSON.stringify({ status: 'error', code: 'METHOD_NOT_ALLOWED', message: 'Метод не поддерживается' }),
        {
          status: 405,
          headers: { Allow: allow, 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
        },
      )
    }
    routeName = route.name

    if (method === 'POST') {
      const crossOriginResponse = rejectCrossOrigin(request)
      if (crossOriginResponse) return crossOriginResponse
    }
    return await route.handle(request, route.match(segments) ?? {})
  } catch (error) {
    return errorResponse(error, method, routeName)
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  return dispatchRequest('GET', request, context)
}

export async function POST(request: NextRequest, context: RouteContext) {
  return dispatchRequest('POST', request, context)
}
