import { NextResponse } from 'next/server'

/**
 * Auth endpoints change a browser cookie, so reject cross-origin requests.
 * Browsers normally send Origin for POST; non-browser health checks without it
 * remain compatible and are still protected by the session/API contract.
 */
export function rejectCrossOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get('origin')
  if (!origin) return null

  try {
    if (new URL(origin).origin !== new URL(request.url).origin) {
      return NextResponse.json(
        { status: 'error', code: 'FORBIDDEN', message: 'Запрос с другого сайта запрещён' },
        { status: 403 },
      )
    }
  } catch {
    return NextResponse.json(
      { status: 'error', code: 'FORBIDDEN', message: 'Некорректный источник запроса' },
      { status: 403 },
    )
  }

  return null
}
