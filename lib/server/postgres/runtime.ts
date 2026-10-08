import 'server-only'
import { createPostgresAuth } from './auth'
import { getPostgresClient } from './client'
import { createPostgresRouter, postgresJson } from './http'
import { publicPostgresError } from './errors'
import { serverLog } from '../logger'

let handler: ReturnType<typeof createPostgresRouter> | undefined

export async function dispatchPostgresRequest(request: Request, segments: string[]) {
  try {
    if (!handler) {
      const db = getPostgresClient()
      handler = createPostgresRouter(db, createPostgresAuth(db, process.env), process.env)
    }
    const startedAt = performance.now()
    const response = await handler(request, segments)
    response.headers.set('Server-Timing', `crm;dur=${Math.round(performance.now() - startedAt)}`)
    if (response.status >= 400) {
      const path = segments.join('/')
      const route = ['auth/login', 'auth/logout', 'auth/session', 'auth/register', 'crm'].includes(path)
        ? path
        : 'unmatched'
      serverLog('warn', 'postgres.request.failed', { method: request.method, route, status: response.status })
    }
    return response
  } catch (error) {
    const failure = publicPostgresError(error)
    serverLog('error', 'postgres.runtime.failed', { code: failure.code, status: failure.status })
    return postgresJson({ status: 'error', code: failure.code, message: failure.message }, failure.status)
  }
}
