import { NextRequest, NextResponse } from 'next/server'
import { callGas, GasError } from '@/lib/server/gas'
import { dispatchCrmAction, UPLOAD_ACTIONS } from '@/lib/server/crm-router'
import { PolicyError } from '@/lib/server/policy'
import { rejectCrossOrigin } from '@/lib/server/request'
import { clearSession, createSession, getSession } from '@/lib/server/session'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ path?: string[] }> }
type JsonRecord = Record<string, unknown>
type HttpMethod = 'GET' | 'POST'
type RouteValues = { clientId?: string }
type RouteHandler = (request: NextRequest, values: RouteValues) => Promise<Response>
type RouteDefinition = {
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

function routeLog(event: string, details: Record<string, unknown> = {}): void {
  console.log('[lotos-route] ' + event, details)
}

class RouteError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'RouteError'
  }
}

function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
}

function jsonError(message: string, status: number): NextResponse {
  return jsonResponse({ status: 'error', message }, status)
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

async function handleLogin(request: NextRequest): Promise<Response> {
  routeLog('auth.login.start')
  const body = await readJson(request, MAX_AUTH_BYTES)
  const username = requiredText(body.username, 100)
  const password = requiredText(body.password, 200, false)
  const response = (await callGas({ action: 'login', payload: { username, password } })) as JsonRecord
  const gasUser = response.user as { role?: unknown; branchId?: unknown } | undefined
  const isCoach = ['coach', '2'].includes(String(gasUser?.role ?? '').toLowerCase())
  if (isCoach && (gasUser?.branchId === null || gasUser?.branchId === undefined || gasUser.branchId === '')) {
    return jsonError('Аккаунт ожидает назначения филиала администратором', 403)
  }
  const user = await createSession(response.user)
  routeLog('auth.login.session.created', { userId: user.id, role: user.role })
  return jsonResponse({ status: 'success', user })
}

async function handleLogout(): Promise<Response> {
  await clearSession()
  return jsonResponse({ status: 'success' })
}

async function handleSession(): Promise<Response> {
  routeLog('auth.session.start')
  const user = await getSession({ revalidate: true })
  if (!user) {
    routeLog('auth.session.invalid', { authenticated: false })
    await clearSession()
    return jsonResponse({ authenticated: false, user: null })
  }
  routeLog('auth.session.ok', { userId: user.id, role: user.role })
  return jsonResponse({ authenticated: Boolean(user), user })
}

async function handleCrm(request: NextRequest): Promise<Response> {
  const body = await readJson(request, MAX_REQUEST_BYTES)
  const action = typeof body.action === 'string' ? body.action : ''
  if (!action || action === 'login') {
    throw new RouteError('Используйте endpoint авторизации', 400)
  }

  const payload = safePayload(body.payload)
  routeLog('crm.start', { action })
  if (!UPLOAD_ACTIONS.has(action) && bodySize(payload) > MAX_STANDARD_BYTES) {
    throw new RouteError('Запрос слишком большой', 413)
  }
  const user = await getSession()
  if (!user) {
    routeLog('crm.denied', { action, reason: 'session.invalid' })
    throw new RouteError('Требуется авторизация', 401)
  }
  const result = await dispatchCrmAction({ action, payload, user })
  routeLog('crm.success', { action })
  return jsonResponse(result)
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
  if (result.base64.length > MAX_RECEIPT_BASE64_BYTES) throw new GasError('Квитанция слишком большая', 502)

  const bytes = Buffer.from(result.base64, 'base64')
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new GasError('Квитанция слишком большая', 502)
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
  { method: 'GET', match: exactRoute('auth', 'session'), handle: handleSession },
  {
    method: 'GET',
    match: (segments) => (segments.length === 2 && segments[0] === 'receipts' ? { clientId: segments[1] } : null),
    handle: handleReceipt,
  },
  { method: 'POST', match: exactRoute('auth', 'login'), handle: handleLogin },
  { method: 'POST', match: exactRoute('auth', 'logout'), handle: handleLogout },
  { method: 'POST', match: exactRoute('crm'), handle: handleCrm },
]

function errorResponse(error: unknown): NextResponse {
  if (error instanceof RouteError || error instanceof PolicyError || error instanceof GasError) {
    console.warn('[lotos-route] request.error', { name: error.name, status: error.status, message: error.message })
    return jsonError(error.message, error.status)
  }
  console.error('[lotos-route] request.unhandled', error)
  return jsonError('Внутренняя ошибка сервера', 500)
}

async function dispatchRequest(method: HttpMethod, request: NextRequest, context: RouteContext): Promise<Response> {
  try {
    const segments = (await context.params).path ?? []
    const matchingRoutes = ROUTES.filter((candidate) => candidate.match(segments) !== null)
    const route = matchingRoutes.find((candidate) => candidate.method === method)
    if (!route) {
      if (matchingRoutes.length === 0) return jsonError('Маршрут не найден', 404)
      const allow = [...new Set(matchingRoutes.map((candidate) => candidate.method))].join(', ')
      return new NextResponse(JSON.stringify({ status: 'error', message: 'Метод не поддерживается' }), {
        status: 405,
        headers: { Allow: allow, 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
      })
    }

    if (method === 'POST') {
      const crossOriginResponse = rejectCrossOrigin(request)
      if (crossOriginResponse) return crossOriginResponse
    }
    return await route.handle(request, route.match(segments) ?? {})
  } catch (error) {
    return errorResponse(error)
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  return dispatchRequest('GET', request, context)
}

export async function POST(request: NextRequest, context: RouteContext) {
  return dispatchRequest('POST', request, context)
}
