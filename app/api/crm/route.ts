import { NextRequest, NextResponse } from 'next/server'
import { callGas, GasError } from '@/lib/server/gas'
import { getSession, type SessionUser } from '@/lib/server/session'
import { assertActionAllowed, PolicyError, withBranchScope } from '@/lib/server/policy'

export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 8 * 1024 * 1024
const MAX_STANDARD_BYTES = 512 * 1024
const UPLOAD_ACTIONS = new Set(['uploadReceipt'])

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ status: 'error', message }, { status })
}

function bodySize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function safePayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...(value as Record<string, unknown>) }
}

function gasAuth(user: SessionUser): Record<string, unknown> {
  return { id: user.id, username: user.username, role: user.role, branchId: user.branchId }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return jsonError('Недопустимый источник запроса', 403)

  const declaredLength = Number(request.headers.get('content-length') || 0)
  if (declaredLength > MAX_REQUEST_BYTES) return jsonError('Запрос слишком большой', 413)

  try {
    const body = (await request.json()) as Record<string, unknown>
    if (bodySize(body) > MAX_REQUEST_BYTES) return jsonError('Запрос слишком большой', 413)

    const action = typeof body.action === 'string' ? body.action : ''
    if (!action || action === 'login' || action === 'register') {
      return jsonError('Используйте endpoint авторизации', 400)
    }
    const user = await getSession()
    if (!user) return jsonError('Требуется авторизация', 401)

    assertActionAllowed(action, user)
    const payload = withBranchScope(safePayload(body.payload), user)
    if (!UPLOAD_ACTIONS.has(action) && bodySize(payload) > MAX_STANDARD_BYTES) {
      return jsonError('Запрос слишком большой', 413)
    }

    if (action === 'uploadReceipt') {
      const encoded = typeof payload.fileBase64 === 'string' ? payload.fileBase64 : ''
      if (encoded.length > 7 * 1024 * 1024) return jsonError('Файл слишком большой', 413)
      const mime = typeof payload.mimeType === 'string' ? payload.mimeType : ''
      if (!['image/jpeg', 'image/png', 'application/pdf'].includes(mime)) {
        return jsonError('Разрешены только JPG, PNG и PDF', 415)
      }
    }

    const data = await callGas({ action, payload, auth: gasAuth(user) })
    return NextResponse.json(data)
  } catch (error) {
    if (error instanceof PolicyError || error instanceof GasError) {
      return jsonError(error.message, error.status)
    }
    return jsonError(error instanceof Error ? error.message : 'Ошибка API', 400)
  }
}
