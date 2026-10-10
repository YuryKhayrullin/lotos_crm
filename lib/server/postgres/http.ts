import 'server-only'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import type { PrismaClient } from '../../../.generated/prisma/client'
import { validateEnvironment } from '../../../scripts/lib/environment.mjs'
import { accountInputSchemas, loginSchema, registrationSchema, type AccountAction } from './auth-input'
import { apiUser, authorizeAction, requireActor, type PostgresAuth } from './access'
import { coachAccounts, mutateCoachAccount, registerPendingCoach } from './accounts'
import { bootstrapData, dashboardSummary } from './reads'
import { checkAuthRate } from './rate-limit'
import { PostgresApiError, publicPostgresError } from './errors'
import { clientHistory } from './history'
import {
  assertReceiptsEnabled,
  uploadReceipt,
  readReceipt,
  receiptResponse,
  receiptAttempts,
  resumeReceipt,
  closeReceiptAttempt,
} from './documents'
import {
  accountingSchemas,
  mutateAccounting,
  auditAccounting,
  financeSummary,
  type AccountingAction,
} from './accounting'
import { scheduleSchemas, mutateSchedule, scheduleRows, type ScheduleAction } from './schedule'
import {
  lessonRoster,
  prepareAttendance,
  recordAttendance,
  acknowledgeAttendance,
  singleAttendancePayload,
} from './attendance'
import { catalogSchemas, mutateCatalog, clientsPage, catalogSheet, clientOptions, type CatalogAction } from './catalog'
import { mutationDrafts, closeMutationDraft, recoverableActions } from './mutations'
import type { DocumentStorage } from './blob-storage'
import { receiptUploadLimit } from '../../receipt-limits'

export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || ''))
    throw new PostgresApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Ожидается application/json')
  if (Number(request.headers.get('content-length') || 0) > maxBytes)
    throw new PostgresApiError(413, 'PAYLOAD_TOO_LARGE', 'Запрос слишком большой')
  const reader = request.body?.getReader()
  if (!reader) throw new PostgresApiError(400, 'VALIDATION', 'Тело запроса отсутствует')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel()
        throw new PostgresApiError(413, 'PAYLOAD_TOO_LARGE', 'Запрос слишком большой')
      }
      chunks.push(value)
    }
    const bytes = Buffer.concat(chunks, length)
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw new PostgresApiError(400, 'VALIDATION', 'Некорректный JSON')
    }
  } finally {
    reader.releaseLock()
  }
}

export function postgresJson(data: unknown, status = 200, extra?: Headers) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-crm-backend': 'postgres',
  })
  for (const value of extra?.getSetCookie() || []) headers.append('set-cookie', value)
  if (status === 429) headers.set('retry-after', '900')
  return new Response(JSON.stringify(data), { status, headers })
}

function requireTrustedPost(request: Request, values: NodeJS.ProcessEnv) {
  if (
    request.headers.get('origin') !== new URL(values.APP_URL!).origin ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    throw new PostgresApiError(403, 'FORBIDDEN', 'Запрос с другого сайта запрещён')
}

const legacyCookieExpiry = 'lotos_crm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
let dummyCredential: Promise<string> | undefined
function cookieHeaders(response: Response) {
  return new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  })
}

export function createPostgresRouter(
  db: PrismaClient,
  auth: PostgresAuth,
  values: NodeJS.ProcessEnv,
  dependencies: { documentStorage?: DocumentStorage } = {},
) {
  validateEnvironment(values, values.APP_ENV)
  const origin = new URL(values.APP_URL!).origin
  const internalAuth = (path: string, body?: unknown, cookie?: string) =>
    auth.handler(
      new Request(origin + '/api/auth/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const handle = async (request: Request, segments: string[]): Promise<Response> => {
    try {
      const path = segments.join('/')
      if (segments.some((segment) => segment.includes('/')))
        throw new PostgresApiError(404, 'NOT_FOUND', 'Маршрут не найден')
      const known = new Map([
        ['auth/login', 'POST'],
        ['auth/logout', 'POST'],
        ['auth/register', 'POST'],
        ['auth/session', 'GET'],
        ['crm', 'POST'],
      ])
      if (!known.has(path)) {
        if (path === 'mutation-drafts') {
          const actor = await requireActor(db, auth, request.headers)
          if (request.method === 'GET') return postgresJson(await mutationDrafts(db, actor))
          if (request.method !== 'POST')
            return new Response(null, { status: 405, headers: { allow: 'GET, POST', 'cache-control': 'no-store' } })
          requireTrustedPost(request, values)
          const input = z
            .object({
              requestId: z.string().min(1).max(150),
              mode: z.enum(['recover', 'acknowledge', 'close']),
              password: z.string().min(8).max(200).optional(),
            })
            .strict()
            .parse(await readBoundedJson(request, 4096))
          if (input.mode !== 'recover')
            return postgresJson(await closeMutationDraft(db, actor, input.requestId, input.mode === 'acknowledge'))
          const draft = await db.mutationDraft.findUnique({
            where: { actorId_requestKey: { actorId: actor.id, requestKey: input.requestId } },
          })
          if (!draft || !recoverableActions.has(draft.action))
            throw new PostgresApiError(404, 'NOT_FOUND', 'Попытка не найдена')
          authorizeAction(draft.action, actor)
          // Recovery reuses the original private payload; it cannot substitute
          // a new amount/group/key. Each writer rechecks fresh access and locks.
          // A confirmed marker is acknowledged without replaying now-stale
          // parameters (e.g. a lesson date that has since passed).
          const marker = await db.mutationRequest.findUnique({
            where: { actorId_requestKey: { actorId: actor.id, requestKey: input.requestId } },
          })
          if (marker) return postgresJson(await closeMutationDraft(db, actor, input.requestId, true))
          if (draft.state !== 'pending') throw new PostgresApiError(409, 'CONFLICT', 'Попытка закрыта')
          if (draft.requiresCredential && !input.password)
            throw new PostgresApiError(
              422,
              'CREDENTIAL_REQUIRED',
              'Введите исходный пароль этой попытки; он не сохранялся для восстановления',
            )
          if (!draft.requiresCredential && input.password)
            throw new PostgresApiError(400, 'VALIDATION', 'Для этой попытки пароль не требуется')
          const payload = {
            ...(draft.payload as Record<string, unknown>),
            ...(draft.requiresCredential
              ? { [draft.action === 'resetCoachPassword' ? 'newPassword' : 'password']: input.password }
              : {}),
          }
          if (Object.hasOwn(catalogSchemas, draft.action))
            await mutateCatalog(db, actor, draft.action as CatalogAction, payload, values.BETTER_AUTH_SECRET!)
          else if (Object.hasOwn(scheduleSchemas, draft.action))
            await mutateSchedule(db, actor, draft.action as ScheduleAction, payload, values.BETTER_AUTH_SECRET!)
          else if (Object.hasOwn(accountInputSchemas, draft.action))
            await mutateCoachAccount(db, actor, draft.action as AccountAction, payload, values.BETTER_AUTH_SECRET!)
          else if (Object.hasOwn(accountingSchemas, draft.action))
            await mutateAccounting(db, actor, draft.action as AccountingAction, payload, values.BETTER_AUTH_SECRET!)
          else throw new PostgresApiError(400, 'VALIDATION', 'Восстановление действия не поддерживается')
          return postgresJson(await closeMutationDraft(db, actor, input.requestId, true))
        }
        if (segments.length === 3 && segments[0] === 'receipts' && segments[2] === 'attempts') {
          const actor = await requireActor(db, auth, request.headers)
          authorizeAction('uploadReceipt', actor)
          assertReceiptsEnabled(values)
          if (request.method === 'GET')
            return postgresJson(await receiptAttempts(db, actor, segments[1], values, dependencies.documentStorage))
          if (request.method === 'POST') {
            requireTrustedPost(request, values)
            const input = z
              .object({ requestId: z.string().min(1).max(150), discard: z.boolean().optional() })
              .strict()
              .parse(await readBoundedJson(request, 4096))
            return postgresJson(
              input.discard === true
                ? await closeReceiptAttempt(db, actor, segments[1], input.requestId)
                : await resumeReceipt(
                    db,
                    actor,
                    segments[1],
                    { requestId: input.requestId },
                    values,
                    dependencies.documentStorage,
                  ),
            )
          }
          return new Response(null, { status: 405, headers: { allow: 'GET, POST', 'cache-control': 'no-store' } })
        }
        if (segments.length === 2 && segments[0] === 'receipts') {
          const actor = await requireActor(db, auth, request.headers)
          if (request.method === 'GET') {
            authorizeAction('getReceipt', actor)
            assertReceiptsEnabled(values)
            return await receiptResponse(db, actor, segments[1], values, dependencies.documentStorage)
          }
          if (request.method === 'POST') {
            requireTrustedPost(request, values)
            authorizeAction('uploadReceipt', actor)
            assertReceiptsEnabled(values)
            const input = await readBoundedJson(
              request,
              Math.ceil(((dependencies.documentStorage?.maxBytes ?? receiptUploadLimit(values)) * 4) / 3) + 32_768,
            )
            if (!input || typeof input !== 'object' || !('clientId' in input) || input.clientId !== segments[1])
              throw new PostgresApiError(400, 'VALIDATION', 'Клиент не соответствует адресу загрузки')
            return postgresJson(await uploadReceipt(db, actor, input, values, dependencies.documentStorage))
          }
          return new Response(null, { status: 405, headers: { allow: 'GET, POST', 'cache-control': 'no-store' } })
        }
        throw new PostgresApiError(404, 'NOT_FOUND', 'Маршрут не найден')
      }
      if (request.method !== known.get(path))
        return new Response(
          JSON.stringify({ status: 'error', code: 'METHOD_NOT_ALLOWED', message: 'Метод не поддерживается' }),
          {
            status: 405,
            headers: { allow: known.get(path)!, 'content-type': 'application/json', 'cache-control': 'no-store' },
          },
        )
      if (request.method === 'POST') requireTrustedPost(request, values)
      if (path === 'auth/login') {
        const input = loginSchema.parse(await readBoundedJson(request, 16_384))
        await checkAuthRate(db, values, request.headers, input.username, 'login')
        // Capture BEFORE password verification. A reset during hashing must not
        // let old credentials obtain the newly incremented session version.
        const candidate = await db.user.findUnique({
          where: { username: input.username },
          select: {
            id: true,
            authVersion: true,
            accounts: { where: { providerId: 'credential' }, select: { password: true }, take: 1 },
          },
        })
        if (candidate?.accounts[0]?.password?.startsWith('scrypt$')) {
          // Recognize the legacy format only to reject it safely. Never treat
          // it as Better Auth-compatible or replace it from a browser login.
          dummyCredential ??= hashPassword(randomBytes(32).toString('hex'))
          await verifyPassword({ password: input.password, hash: await dummyCredential })
          throw new PostgresApiError(401, 'UNAUTHORIZED', 'Неверный логин или пароль')
        }
        const result = await internalAuth('sign-in/username', { ...input, rememberMe: false })
        if (!result.ok) {
          const failure = await result.json().catch(() => null)
          if (result.status >= 500 && failure?.code !== 'FAILED_TO_CREATE_SESSION')
            throw new PostgresApiError(503, 'SERVICE_UNAVAILABLE', 'Вход временно недоступен')
          throw new PostgresApiError(401, 'UNAUTHORIZED', 'Неверный логин или пароль')
        }
        const issuedHeaders = cookieHeaders(result)
        try {
          const actor = await requireActor(db, auth, issuedHeaders)
          if (!candidate || candidate.id !== actor.id || candidate.authVersion !== actor.authVersion)
            throw new PostgresApiError(401, 'UNAUTHORIZED', 'Неверный логин или пароль')
          const headers = new Headers(result.headers)
          headers.append('set-cookie', legacyCookieExpiry)
          return postgresJson({ status: 'success', user: apiUser(actor) }, 200, headers)
        } catch (error) {
          await internalAuth('sign-out', undefined, issuedHeaders.get('cookie') || '').catch(() => undefined)
          throw error
        }
      }
      if (path === 'auth/logout') {
        // Logout also works for a revoked/disabled identity; it grants no data.
        const result = await internalAuth('sign-out', undefined, request.headers.get('cookie') || '')
        if (!result.ok) throw new PostgresApiError(503, 'SERVICE_UNAVAILABLE', 'Не удалось завершить сессию')
        const headers = new Headers(result.headers)
        headers.append('set-cookie', legacyCookieExpiry)
        return postgresJson({ status: 'success' }, 200, headers)
      }
      if (path === 'auth/register') {
        if (values.COACH_REGISTRATION_ENABLED !== 'true')
          throw new PostgresApiError(403, 'FORBIDDEN', 'Самостоятельная регистрация выключена')
        const input = registrationSchema.parse(await readBoundedJson(request, 16_384))
        await checkAuthRate(db, values, request.headers, input.username, 'registration')
        return postgresJson(await registerPendingCoach(db, input, values.BETTER_AUTH_SECRET!))
      }
      const actor = await requireActor(db, auth, request.headers)
      if (path === 'auth/session') return postgresJson({ authenticated: true, user: apiUser(actor) })
      const envelope = z
        .object({ action: z.string().min(1).max(64), payload: z.record(z.string(), z.unknown()).default({}) })
        .strict()
        .parse(await readBoundedJson(request, 65_536))
      authorizeAction(envelope.action, actor)
      if (envelope.action === 'uploadReceipt' || envelope.action === 'getReceipt') assertReceiptsEnabled(values)
      if (Object.hasOwn(scheduleSchemas, envelope.action))
        return postgresJson(
          await mutateSchedule(
            db,
            actor,
            envelope.action as ScheduleAction,
            envelope.payload,
            values.BETTER_AUTH_SECRET!,
          ),
        )
      if (envelope.action === 'getSchedule')
        return postgresJson({ items: await scheduleRows(db, actor, envelope.payload) })
      if (envelope.action === 'getLessonRoster') return postgresJson(await lessonRoster(db, actor, envelope.payload))
      if (envelope.action === 'prepareAttendance')
        return postgresJson(await prepareAttendance(db, actor, envelope.payload, values.BETTER_AUTH_SECRET!))
      if (envelope.action === 'acknowledgeAttendance')
        return postgresJson(await acknowledgeAttendance(db, actor, envelope.payload))
      if (envelope.action === 'recordBulkAttendance' || envelope.action === 'recordAttendance')
        return postgresJson(
          await recordAttendance(
            db,
            actor,
            envelope.action === 'recordAttendance' ? singleAttendancePayload(envelope.payload) : envelope.payload,
            values.BETTER_AUTH_SECRET!,
          ),
        )
      if (envelope.action === 'getSheet' && envelope.payload.sheet === 'Расписание') {
        const data = z
          .object({ sheet: z.literal('Расписание'), branchId: z.string().min(1).max(100).optional() })
          .strict()
          .parse(envelope.payload)
        return postgresJson(await scheduleRows(db, actor, data.branchId ? { branchId: data.branchId } : {}))
      }
      if (Object.hasOwn(accountInputSchemas, envelope.action))
        return postgresJson(
          await mutateCoachAccount(
            db,
            actor,
            envelope.action as AccountAction,
            envelope.payload,
            values.BETTER_AUTH_SECRET!,
          ),
        )
      if (envelope.action === 'getUsers') {
        z.object({}).strict().parse(envelope.payload)
        return postgresJson(await coachAccounts(db))
      }
      if (Object.hasOwn(catalogSchemas, envelope.action))
        return postgresJson(
          await mutateCatalog(
            db,
            actor,
            envelope.action as CatalogAction,
            envelope.payload,
            values.BETTER_AUTH_SECRET!,
          ),
        )
      if (Object.hasOwn(accountingSchemas, envelope.action))
        return postgresJson(
          await mutateAccounting(
            db,
            actor,
            envelope.action as AccountingAction,
            envelope.payload,
            values.BETTER_AUTH_SECRET!,
          ),
        )
      if (envelope.action === 'auditLessonLedger')
        return postgresJson(await auditAccounting(db, actor, envelope.payload, values.BETTER_AUTH_SECRET!))
      if (envelope.action === 'getFinanceSummary')
        return postgresJson(await financeSummary(db, actor, envelope.payload))
      if (envelope.action === 'getClients' || envelope.action === 'getSubscriptionsPage')
        return postgresJson(await clientsPage(db, actor, envelope.payload))
      if (envelope.action === 'getSheet') return postgresJson(await catalogSheet(db, actor, envelope.payload))
      if (envelope.action === 'searchClientOptions')
        return postgresJson(await clientOptions(db, actor, envelope.payload))
      if (envelope.action === 'getClientHistory')
        return postgresJson(await clientHistory(db, actor, envelope.payload, values.BETTER_AUTH_SECRET!))
      if (envelope.action === 'uploadReceipt')
        return postgresJson(await uploadReceipt(db, actor, envelope.payload, values, dependencies.documentStorage))
      if (envelope.action === 'getReceipt') {
        const input = z
          .object({ clientId: z.string().min(1).max(100) })
          .strict()
          .parse(envelope.payload)
        const result = await readReceipt(db, actor, input.clientId, values, dependencies.documentStorage)
        return postgresJson({
          success: true,
          fileName: result.document.originalName,
          mimeType: result.document.mimeType,
          base64: result.bytes.toString('base64'),
        })
      }
      if (envelope.action === 'getCurrentUser') {
        z.object({}).strict().parse(envelope.payload)
        return postgresJson({ status: 'success', user: apiUser(actor) })
      }
      if (envelope.action === 'getBootstrapData') return postgresJson(await bootstrapData(db, actor, envelope.payload))
      if (envelope.action === 'getDashboardSummary')
        return postgresJson(await dashboardSummary(db, actor, envelope.payload))
      throw new PostgresApiError(
        503,
        'SERVICE_UNAVAILABLE',
        'Этот раздел ещё не перенесён в PostgreSQL; обращения к GAS нет',
      )
    } catch (error) {
      const failure = publicPostgresError(error)
      return postgresJson(
        {
          status: 'error',
          code: failure.code,
          message: failure.message,
          ...(segments.join('/') === 'auth/session' && failure.status === 401
            ? { authenticated: false, user: null }
            : {}),
        },
        failure.status,
      )
    }
  }
  return async (request: Request, segments: string[]) => {
    const response = await handle(request, segments)
    response.headers.set(
      'x-crm-receipt-max-bytes',
      String(
        receiptUploadLimit(values) === 0 ? 0 : (dependencies.documentStorage?.maxBytes ?? receiptUploadLimit(values)),
      ),
    )
    return response
  }
}
