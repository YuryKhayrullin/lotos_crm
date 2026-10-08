import { IBranch, ICoach, IClient, ILesson, CreateClientDto, UserRole } from '@/store/models'
import { devLog } from './dev-log'
import { normalizeLesson, normalizeClient } from './normalizers'
import { clearAttendanceDrafts } from './attendance-recovery'

const API_ROUTE = '/api/crm'
const AUTH_ROUTE = '/api/auth'

const MUTATING_ACTIONS = new Set([
  'assignUserBranch',
  'deactivateUser',
  'activateUser',
  'resetCoachPassword',
  'revokeUserSessions',
  'linkCoachUser',
  'createClient',
  'createLesson',
  'createLessonWithClients',
  'createBranch',
  'createCoach',
  'updateClient',
  'assignClientLesson',
  'updateLesson',
  'cancelLesson',
  'deleteClient',
  'deleteCoach',
  'deleteLesson',
  'recordAttendance',
  'recordBulkAttendance',
  'prepareAttendance',
  'acknowledgeAttendance',
  'recordPayment',
  'recordAdjustment',
  'repairLessonLedger',
  'uploadReceipt',
])

export function createRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export type ApiUser = {
  id: string | number
  username: string
  role: UserRole
  branchId: string | number | null
}

function isApiUser(value: unknown): value is ApiUser {
  if (!value || typeof value !== 'object') return false
  const user = value as ApiUser
  const validId =
    typeof user.id === 'string' ? Boolean(user.id.trim()) : typeof user.id === 'number' && Number.isFinite(user.id)
  return (
    validId &&
    typeof user.username === 'string' &&
    Boolean(user.username.trim()) &&
    ['admin', 'coach'].includes(user.role) &&
    (user.branchId === null ||
      typeof user.branchId === 'string' ||
      (typeof user.branchId === 'number' && Number.isFinite(user.branchId)))
  )
}

export type CoachAccount = {
  id: string
  username: string
  role: 'coach'
  branchId: string | null
  status: 'Активен' | 'Отключен' | 'Ожидает подтверждения'
  disabledAt: string | null
  disabledBy: string | null
  canRevokeSessions?: boolean
  profileArchived?: boolean
}

export class ApiError extends Error {
  public readonly code: string | null

  constructor(
    public status: number | string,
    public data: unknown,
  ) {
    const message =
      typeof data === 'string'
        ? data
        : data && typeof data === 'object' && 'message' in data
          ? String(data.message)
          : `API Error: ${status}`
    super(message)
    this.name = 'ApiError'
    this.code = data && typeof data === 'object' && 'code' in data ? String(data.code) : null
  }
}

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.readAsDataURL(file)
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = reject
  })

export type ReceiptAttempt = {
  requestId: string
  resumable: boolean
  createdAt: string
  metadata: {
    clientId: string
    expectedReceiptVersion: number
    fileName: string
    mimeType: string
    sha256: string
    sizeBytes: number
  } | null
}

type JsonObject = Record<string, unknown>

async function fetchJson(url: string, options: RequestInit = {}): Promise<{ response: Response; data: unknown }> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (options.signal?.aborted) abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 45_000)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const data = await response.json().catch(() => null)
    return { response, data }
  } catch {
    throw new ApiError(503, {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Сервис не ответил. Проверьте соединение и повторите попытку.',
    })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

function rowsWithIds(value: unknown): JsonObject[] {
  const ids = new Set<string>()
  if (
    !Array.isArray(value) ||
    value.some((item) => {
      if (!item || typeof item !== 'object' || !String(item.id ?? '').trim() || ids.has(String(item.id))) return true
      ids.add(String(item.id))
      return false
    })
  ) {
    throw new ApiError(502, { code: 'INVALID_RESPONSE', message: 'Сервис вернул неполные данные. Повторите загрузку.' })
  }
  return value as JsonObject[]
}

export type LessonRosterClient = {
  id: string
  childName: string
  parentName: string
  category: string
  status: string
  remainingLessons: number
  mark: 'attended' | 'absent' | null
  version?: number
  canMark?: boolean
}

export type LessonRoster = {
  lessonId: string
  date: string
  clients: LessonRosterClient[]
  lessonVersion?: number
  pendingAttempt?: import('./attendance-recovery').AttendanceAttempt | null
}

export type AttendanceResult = {
  clientId: string
  success: boolean
  message?: string
  duplicate?: boolean
  client?: { remainingLessons: number; totalLessons: number; status: string }
}

export type ClientsPage = {
  items: ReturnType<typeof normalizeClient>[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

export type DashboardClientPreview = {
  id: string
  childName: string
  parentName: string
  phone: string
  initials: string
  remainingLessons: number
  status: string
}

export type DashboardSummary = {
  totalClients: number
  activeClients: number
  pausedClients: number
  archivedClients: number
  previewTotal: number
  previewLimit: number
  clientsPreview: DashboardClientPreview[]
}

export type FinanceSummary = {
  totalClients: number
  activeClients: number
  pausedClients: number
  archivedClients: number
  totalPaidAmount: number
  remainingLessons: number
  totalLessons: number
}

export type ClientOption = {
  id: string
  childName: string
  parentName: string
  branchId: string
  category: string
  remainingLessons: number
}

export type BootstrapData = {
  coachAccounts?: CoachAccount[]
  branches: IBranch[]
  coaches: ICoach[]
  lessons: ReturnType<typeof normalizeLesson>[]
}

export type LessonLedgerDiscrepancy = {
  clientId: string
  childName: string
  branchId: string
  current: { remainingLessons: number; totalLessons: number }
  calculated: { remainingLessons: number; totalLessons: number }
  ledgerIssues: string[]
  paymentIssues: string[]
  missingPaymentIds: string[]
  repairable: boolean
  auditFingerprint?: string
}

export type LessonLedgerAudit = {
  success: boolean
  checked: number
  discrepancies: LessonLedgerDiscrepancy[]
}

export type AccountingClientSnapshot = {
  remainingLessons: number
  totalLessons: number
  paidAmount: number
  paymentBalance: number
  category: 'плавание' | 'синхронное плавание'
  lessonsPerWeek: number
  status: 'Активен' | 'Пауза' | 'Архив'
}

export type ClientHistory = {
  success: boolean
  payments: JsonObject[]
  ledger: JsonObject[]
  attendanceHistory?: JsonObject[]
  attendanceTotal?: number
  legacyHistory?: { namespace: string; history: JsonObject[] }[]
}

export type ClientAccounting = ClientHistory & {
  client?: AccountingClientSnapshot
  audit: LessonLedgerAudit | null
  auditError?: { code?: string; message: string }
}

export type PaymentResult = {
  success: boolean
  duplicate?: boolean
  payment: JsonObject
  client: AccountingClientSnapshot
  // Optional during a rolling release with the previous GAS deployment.
  ledgerEntry?: JsonObject
  audit?: LessonLedgerAudit
}

function validAccountingSnapshot(value: unknown): value is AccountingClientSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as AccountingClientSnapshot
  return (
    ['remainingLessons', 'totalLessons', 'paidAmount', 'paymentBalance'].every((field) => {
      const number = snapshot[field as keyof AccountingClientSnapshot]
      return typeof number === 'number' && Number.isFinite(number) && number >= 0
    }) &&
    snapshot.remainingLessons <= snapshot.totalLessons &&
    ['Активен', 'Пауза', 'Архив'].includes(snapshot.status) &&
    ['плавание', 'синхронное плавание'].includes(snapshot.category) &&
    [1, 2, 3].includes(snapshot.lessonsPerWeek)
  )
}

function validLedgerAudit(value: unknown): value is LessonLedgerAudit {
  if (!value || typeof value !== 'object') return false
  const audit = value as LessonLedgerAudit
  return (
    audit.success === true &&
    Number.isInteger(audit.checked) &&
    audit.checked >= 0 &&
    Array.isArray(audit.discrepancies) &&
    audit.discrepancies.every(
      (item) =>
        item &&
        typeof item.clientId === 'string' &&
        typeof item.repairable === 'boolean' &&
        item.current &&
        item.calculated &&
        [
          item.current.remainingLessons,
          item.current.totalLessons,
          item.calculated.remainingLessons,
          item.calculated.totalLessons,
        ].every((number) => typeof number === 'number' && Number.isFinite(number)) &&
        [item.ledgerIssues, item.paymentIssues, item.missingPaymentIds].every(
          (items) => Array.isArray(items) && items.every((text) => typeof text === 'string'),
        ),
    )
  )
}

class ApiClient {
  private readonly inFlightReads = new Map<string, Promise<unknown>>()
  private readGeneration = 0
  private sessionEpoch = 0
  private postgresAccounts = false
  isPostgresBackend(): boolean {
    return this.postgresAccounts
  }

  async mutationDrafts(signal?: AbortSignal): Promise<{
    items: { requestId: string; action: string; confirmed: boolean; createdAt: string; requiresCredential?: boolean }[]
    hasMore: boolean
  }> {
    const { response, data } = await fetchJson('/api/mutation-drafts', { credentials: 'same-origin', signal })
    if (!response.ok) throw new ApiError(response.status, data as JsonObject)
    const value = data as {
      items?: {
        requestId: string
        action: string
        confirmed: boolean
        createdAt: string
        requiresCredential?: boolean
      }[]
      hasMore?: boolean
    } | null
    if (
      !value ||
      !Array.isArray(value.items) ||
      value.items.length > 20 ||
      typeof value.hasMore !== 'boolean' ||
      !value.items.every(
        (item) =>
          item &&
          typeof item.requestId === 'string' &&
          typeof item.action === 'string' &&
          typeof item.confirmed === 'boolean' &&
          typeof item.createdAt === 'string' &&
          (item.requiresCredential === undefined || typeof item.requiresCredential === 'boolean'),
      )
    )
      throw new ApiError(502, { code: 'INVALID_RESPONSE', message: 'Не удалось проверить незавершённые попытки' })
    return { items: value.items, hasMore: value.hasMore }
  }

  async resolveMutationDraft(
    requestId: string,
    mode: 'recover' | 'acknowledge' | 'close',
    password?: string,
  ): Promise<{ success: true; confirmed: boolean }> {
    const { response, data } = await fetchJson('/api/mutation-drafts', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, mode, ...(password === undefined ? {} : { password }) }),
    })
    if (!response.ok) throw new ApiError(response.status, data as JsonObject)
    const value = data as { success?: boolean; confirmed?: boolean } | null
    if (!value || value.success !== true || typeof value.confirmed !== 'boolean')
      throw new ApiError(502, { code: 'INVALID_RESPONSE', message: 'Исход попытки пока не подтверждён' })
    this.readGeneration++
    this.inFlightReads.clear()
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('crm:mutation-attempt'))
    return { success: true, confirmed: value.confirmed }
  }

  private acknowledgeMutation(requestId: string) {
    if (this.postgresAccounts) void this.resolveMutationDraft(requestId, 'acknowledge').catch(() => undefined)
  }
  private readonly accountAttempts = new Map<
    string,
    { fingerprint: string; requestId: string; payload: JsonObject; pending?: Promise<unknown>; uncertain?: boolean }
  >()

  clearPrivateState(): void {
    this.sessionEpoch++
    this.readGeneration += 1
    this.inFlightReads.clear()
    this.accountAttempts.clear()
    this.postgresAccounts = false
    clearAttendanceDrafts()
  }

  private async accountMutation(action: string, userId: string, payload: JsonObject): Promise<{ success: boolean }> {
    return this.stableMutation(action, userId, payload, (result: { success: boolean }) => result?.success === true)
  }

  private async stableMutation<T>(
    action: string,
    entityKey: string,
    payload: JsonObject,
    confirmed: (result: T) => boolean,
    execute?: (payload: JsonObject) => Promise<T>,
  ): Promise<T> {
    if (!this.postgresAccounts) return this.request(action, payload)
    const key = action + ':' + entityKey
    const semanticPayload = { ...payload }
    delete semanticPayload.expectedVersion
    delete semanticPayload.expectedReceiptVersion
    const fingerprint = JSON.stringify(semanticPayload)
    let attempt = this.accountAttempts.get(key)
    if (attempt && attempt.fingerprint !== fingerprint)
      throw new ApiError(409, {
        code: 'CONFLICT',
        message: 'Предыдущая попытка не подтверждена. Повторите её с исходными данными.',
      })
    if (attempt?.pending) return attempt.pending as Promise<T>
    attempt ??= { fingerprint, requestId: createRequestId(), payload: { ...payload } }
    this.accountAttempts.set(key, attempt)
    const current = attempt
    const frozen = { ...current.payload, requestId: current.requestId }
    const operation = (execute ? execute(frozen) : this.request<T>(action, frozen))
      .then((result) => {
        if (!confirmed(result))
          throw new ApiError(502, {
            code: 'INVALID_RESPONSE',
            message: 'Изменение не подтверждено. Повторите ту же попытку.',
          })
        if (this.accountAttempts.get(key) === current) this.accountAttempts.delete(key)
        if (action !== 'uploadReceipt') this.acknowledgeMutation(current.requestId)
        return result
      })
      .catch((error) => {
        if (
          !(error instanceof ApiError) ||
          typeof error.status !== 'number' ||
          error.status === 408 ||
          error.status >= 500
        )
          current.uncertain = true
        if (
          error instanceof ApiError &&
          typeof error.status === 'number' &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408 && // A proxy timeout does not prove the mutation was rejected.
          !current.uncertain &&
          this.accountAttempts.get(key) === current
        )
          this.accountAttempts.delete(key)
        throw error
      })
      .finally(() => {
        current.pending = undefined
      })
    current.pending = operation
    return operation
  }

  private async request<T = unknown>(action: string, payload: JsonObject = {}, signal?: AbortSignal): Promise<T> {
    const sessionEpoch = this.sessionEpoch
    const isMutation = MUTATING_ACTIONS.has(action)
    const requestPayload =
      isMutation && payload.requestId === undefined ? { ...payload, requestId: createRequestId() } : payload

    const execute = async (): Promise<T> => {
      devLog('api.request.start', { action })
      const { response, data } = await fetchJson(API_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action, payload: requestPayload }),
        // Read effects are deliberately not wired to AbortController. React
        // Strict Mode tears effects down once in development; aborting here
        // produced red `(canceled)` requests and discarded useful cache warmup.
        signal: isMutation ? signal : undefined,
      })
      devLog('api.request.response', { action, status: response.status, ok: response.ok })
      if (sessionEpoch !== this.sessionEpoch)
        throw new ApiError(409, {
          code: 'STALE_CONTEXT',
          message: 'Сессия изменилась. Ответ предыдущего пользователя отброшен.',
        })
      if (response.headers?.get('x-crm-backend') === 'postgres') this.postgresAccounts = true

      const object = data && typeof data === 'object' ? (data as JsonObject) : null
      if (!response.ok) {
        throw new ApiError(
          response.status,
          object ?? { status: 'error', message: 'Ошибка запроса (' + response.status + ')' },
        )
      }
      if (data === null)
        throw new ApiError(502, {
          code: 'INVALID_RESPONSE',
          message: 'Сервис вернул неполный ответ. Повторите попытку.',
        })
      if (object?.status === 'error') throw new ApiError(500, object)
      return data as T
    }

    if (isMutation) {
      try {
        return await execute()
      } finally {
        // Never join a pre-mutation read when refreshing the result.
        this.readGeneration += 1
        this.inFlightReads.clear()
        if (
          this.postgresAccounts &&
          typeof window !== 'undefined' &&
          action !== 'uploadReceipt' &&
          action !== 'recordAttendance' &&
          action !== 'recordBulkAttendance'
        )
          window.dispatchEvent(new Event('crm:mutation-attempt'))
      }
    }

    const readKey = `${this.readGeneration}:${action}:${JSON.stringify(requestPayload)}`
    const existing = this.inFlightReads.get(readKey)
    if (existing) return existing as Promise<T>

    const pending = execute().finally(() => {
      if (this.inFlightReads.get(readKey) === pending) this.inFlightReads.delete(readKey)
    })
    this.inFlightReads.set(readKey, pending)
    return pending
  }

  private async authRequest<T>(path: string, payload?: JsonObject): Promise<T> {
    devLog('auth.request.start', { path })
    const { response, data } = await fetchJson(`${AUTH_ROUTE}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload ?? {}),
    })
    devLog('auth.request.response', { path, status: response.status, ok: response.ok })
    const object = data && typeof data === 'object' ? (data as JsonObject) : null
    if (!response.ok || object?.status === 'error') {
      throw new ApiError(
        response.status,
        object ?? { status: 'error', message: 'Ошибка запроса (' + response.status + ')' },
      )
    }
    if (data === null) throw new ApiError(502, { message: 'Сервис вернул неполный ответ. Повторите попытку.' })
    return data as T
  }

  async login(username: string, password: string): Promise<{ user: ApiUser }> {
    const data = await this.authRequest<{ user: ApiUser }>('login', { username, password })
    if (!isApiUser(data?.user)) {
      throw new ApiError(502, { message: 'Не удалось подтвердить вход. Повторите попытку.' })
    }
    return data
  }

  async register(username: string, password: string, requestId: string): Promise<void> {
    const result = await this.authRequest<{ status: string; pending: boolean }>('register', {
      username,
      password,
      requestId,
    })
    if (!result || result.status !== 'success' || result.pending !== true) {
      throw new ApiError(502, {
        code: 'INVALID_RESPONSE',
        message: 'Регистрация не подтверждена. Повторите тот же запрос.',
      })
    }
  }

  async session(): Promise<{ authenticated: boolean; user: ApiUser | null }> {
    const { response, data: value } = await fetchJson(`${AUTH_ROUTE}/session`, {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    devLog('auth.session.response', { status: response.status, ok: response.ok })
    if (response.status === 401) return { authenticated: false, user: null }
    const data = value as { authenticated?: boolean; user?: ApiUser } | null
    if (!response.ok || !data || data.authenticated !== true || !isApiUser(data.user)) {
      throw new ApiError(response.ok ? 502 : response.status, {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Не удалось проверить доступ. Повторите попытку.',
      })
    }
    return { authenticated: true, user: data.user }
  }

  async logout(): Promise<void> {
    await this.authRequest<{ status: string }>('logout')
  }

  async fetchClients(signal?: AbortSignal, branchId?: string): Promise<ReturnType<typeof normalizeClient>[]> {
    const data = await this.request<unknown[]>(
      'getSheet',
      { sheet: 'Клиенты', ...(branchId ? { branchId } : {}) },
      signal,
    )
    return (Array.isArray(data) ? data : []).map(normalizeClient)
  }

  async fetchClientsPage(
    page = 1,
    pageSize = 100,
    signal?: AbortSignal,
    branchId?: string,
    query?: string,
    status?: string,
    sortBy?: 'childName' | 'paidAmount',
    sortDir?: 'asc' | 'desc',
  ): Promise<ClientsPage> {
    return this.fetchClientPageAction('getClients', page, pageSize, signal, branchId, query, status, sortBy, sortDir)
  }

  private async fetchClientPageAction(
    action: 'getClients' | 'getSubscriptionsPage',
    page: number,
    pageSize: number,
    signal?: AbortSignal,
    branchId?: string,
    query?: string,
    status?: string,
    sortBy?: 'childName' | 'paidAmount',
    sortDir?: 'asc' | 'desc',
  ): Promise<ClientsPage> {
    const data = await this.request<{
      items?: unknown[]
      total?: number
      page?: number
      pageSize?: number
      hasMore?: boolean
    }>(
      action,
      {
        page,
        pageSize,
        ...(branchId ? { branchId } : {}),
        ...(query ? { query } : {}),
        ...(status ? { status } : {}),
        ...(sortBy ? { sortBy } : {}),
        ...(sortDir ? { sortDir } : {}),
      },
      signal,
    )
    return {
      items: (Array.isArray(data.items) ? data.items : []).map(normalizeClient),
      total: Number(data.total || 0),
      page: Number(data.page || page),
      pageSize: Number(data.pageSize || pageSize),
      hasMore: Boolean(data.hasMore),
    }
  }

  async getSubscriptionsPage(
    page = 1,
    pageSize = 50,
    signal?: AbortSignal,
    branchId?: string,
    query?: string,
    status?: string,
  ): Promise<ClientsPage> {
    return this.fetchClientPageAction(
      'getSubscriptionsPage',
      page,
      pageSize,
      signal,
      branchId,
      query,
      status,
      'childName',
      'asc',
    )
  }

  async getDashboardSummary(signal?: AbortSignal, branchId?: string): Promise<DashboardSummary> {
    const data = await this.request<Partial<DashboardSummary>>(
      'getDashboardSummary',
      { previewLimit: 5, ...(branchId ? { branchId } : {}) },
      signal,
    )
    return {
      totalClients: Number(data.totalClients || 0),
      activeClients: Number(data.activeClients || 0),
      pausedClients: Number(data.pausedClients || 0),
      archivedClients: Number(data.archivedClients || 0),
      previewTotal: Number(data.previewTotal || 0),
      previewLimit: Number(data.previewLimit || 5),
      clientsPreview: Array.isArray(data.clientsPreview)
        ? data.clientsPreview.map((item) => ({
            id: String(item.id || ''),
            childName: String(item.childName || ''),
            parentName: String(item.parentName || ''),
            phone: String(item.phone || ''),
            initials: String(item.initials || ''),
            remainingLessons: Number(item.remainingLessons || 0),
            status: String(item.status || 'Активен'),
          }))
        : [],
    }
  }

  async getFinanceSummary(signal?: AbortSignal, branchId?: string): Promise<FinanceSummary> {
    const data = await this.request<Partial<FinanceSummary>>('getFinanceSummary', branchId ? { branchId } : {}, signal)
    return {
      totalClients: Number(data.totalClients || 0),
      activeClients: Number(data.activeClients || 0),
      pausedClients: Number(data.pausedClients || 0),
      archivedClients: Number(data.archivedClients || 0),
      totalPaidAmount: Number(data.totalPaidAmount || 0),
      remainingLessons: Number(data.remainingLessons || 0),
      totalLessons: Number(data.totalLessons || 0),
    }
  }

  async searchClientOptions(
    query: string,
    signal?: AbortSignal,
    branchId?: string,
    limit = 20,
    category?: 'плавание' | 'синхронное плавание',
  ): Promise<ClientOption[]> {
    const data = await this.request<{ items?: Partial<ClientOption>[] }>(
      'searchClientOptions',
      { query, limit, ...(branchId ? { branchId } : {}), ...(category ? { category } : {}) },
      signal,
    )
    return (Array.isArray(data.items) ? data.items : [])
      .map((item) => ({
        id: String(item.id || ''),
        childName: String(item.childName || ''),
        parentName: String(item.parentName || ''),
        branchId: String(item.branchId || ''),
        category: String(item.category || 'плавание'),
        remainingLessons: Number(item.remainingLessons || 0),
      }))
      .filter((item) => !category || item.category === category)
  }

  async createClient(clientData: CreateClientDto, requestId: string): Promise<IClient> {
    const data = { ...clientData } as unknown as JsonObject
    if (this.postgresAccounts) delete data.subscription
    const response = await this.request<IClient>('createClient', { ...data, requestId })
    if (!response || typeof response.id !== 'string' || !response.id.trim())
      throw new ApiError(502, {
        code: 'INVALID_RESPONSE',
        message: 'Создание клиента не подтверждено. Повторите тот же запрос.',
      })
    this.acknowledgeMutation(requestId)
    return response
  }

  async deleteClient(id: string, expectedVersion?: number): Promise<void> {
    await this.accountMutation('deleteClient', id, {
      id,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    })
  }

  async fetchBranches(signal?: AbortSignal, branchId?: string): Promise<IBranch[]> {
    const data = await this.request<unknown[]>(
      'getSheet',
      { sheet: 'Филиалы', ...(branchId ? { branchId } : {}) },
      signal,
    )
    return (Array.isArray(data) ? data : []).map((raw) => {
      const value = raw as JsonObject
      return { ...value, id: String(value.id) } as IBranch
    })
  }

  async fetchCoaches(signal?: AbortSignal, branchId?: string): Promise<ICoach[]> {
    const data = await this.request<unknown[]>(
      'getSheet',
      { sheet: 'Тренеры', ...(branchId ? { branchId } : {}) },
      signal,
    )
    return (Array.isArray(data) ? data : []).map((raw) => {
      const value = raw as JsonObject
      return { ...value, id: String(value.id), branchId: value.branchId ? String(value.branchId) : '' } as ICoach
    })
  }

  async getLessonRoster(lessonId: string, date: string, signal?: AbortSignal): Promise<LessonRoster> {
    const data = await this.request<LessonRoster>('getLessonRoster', { lessonId, date }, signal)
    const ids = new Set<string>()
    if (
      !data ||
      data.lessonId !== lessonId ||
      data.date !== date ||
      !Array.isArray(data.clients) ||
      data.clients.some((client) => {
        if (
          !client ||
          typeof client.id !== 'string' ||
          !client.id ||
          ids.has(client.id) ||
          typeof client.childName !== 'string' ||
          typeof client.parentName !== 'string' ||
          !Number.isFinite(client.remainingLessons) ||
          client.remainingLessons < 0 ||
          ![null, 'attended', 'absent'].includes(client.mark)
        )
          return true
        ids.add(client.id)
        return false
      })
    ) {
      throw new ApiError(502, {
        code: 'INVALID_RESPONSE',
        message: 'Не удалось загрузить список занятия. Повторите попытку.',
      })
    }
    return data
  }

  async fetchLessons(signal?: AbortSignal, branchId?: string): Promise<ReturnType<typeof normalizeLesson>[]> {
    const data = await this.request<unknown[]>(
      'getSheet',
      { sheet: 'Расписание', ...(branchId ? { branchId } : {}) },
      signal,
    )
    return (Array.isArray(data) ? data : []).map(normalizeLesson)
  }

  async fetchBootstrapData(signal?: AbortSignal, branchId?: string, includeCoaches = true): Promise<BootstrapData> {
    try {
      const data = await this.request<{
        branches?: unknown[]
        coaches?: unknown[]
        lessons?: unknown[]
        coachAccounts?: CoachAccount[]
      }>(
        'getBootstrapData',
        { ...(branchId ? { branchId } : {}), ...(!includeCoaches ? { includeCoaches: false } : {}) },
        signal,
      )
      if (
        data.coachAccounts !== undefined &&
        (!Array.isArray(data.coachAccounts) ||
          data.coachAccounts.some(
            (account) =>
              !account ||
              typeof account.id !== 'string' ||
              !account.id ||
              typeof account.username !== 'string' ||
              !account.username ||
              account.role !== 'coach' ||
              !['Активен', 'Отключен', 'Ожидает подтверждения'].includes(account.status),
          ))
      )
        throw new ApiError(502, { message: 'Сервис вернул некорректный список тренеров' })
      return {
        ...(includeCoaches && data.coachAccounts !== undefined ? { coachAccounts: data.coachAccounts } : {}),
        branches: rowsWithIds(data.branches).map((value) => {
          return {
            id: String(value.id),
            name: String(value.name || ''),
            address: String(value.address || ''),
            timeZone: String(value.timeZone || 'Europe/Moscow'),
          } as IBranch
        }),
        coaches: rowsWithIds(data.coaches).map((value) => {
          return {
            id: String(value.id),
            branchId: value.branchId ? String(value.branchId) : '',
            name: String(value.name || ''),
            specialty: String(value.specialty || ''),
            initials: String(value.initials || ''),
            userId: String(value.userId || ''),
            phone: String(value.phone || ''),
            birthDate: String(value.birthDate || ''),
          } as ICoach
        }),
        lessons: rowsWithIds(data.lessons).map(normalizeLesson),
      }
    } catch (error) {
      // Keep rolling deployments usable: an older GAS version does not know
      // getBootstrapData and reports it as NOT_FOUND. Once GAS is updated,
      // the fast single-request path above is used automatically.
      if (!(error instanceof ApiError) || (error.status !== 404 && error.code !== 'NOT_FOUND')) throw error
      const [branches, coaches, lessons] = await Promise.all([
        this.fetchBranches(signal),
        includeCoaches ? this.fetchCoaches(signal, branchId) : Promise.resolve([]),
        this.fetchLessons(signal, branchId),
      ])
      return { branches, coaches, lessons }
    }
  }

  async createLesson(lessonData: JsonObject): Promise<ILesson> {
    lessonData = { ...lessonData, requestId: lessonData.requestId || createRequestId() }
    const count = Array.isArray(lessonData.clientIds) ? lessonData.clientIds.length : 0
    const response = await this.request<ILesson & { clientsAssigned?: number }>(
      count ? 'createLessonWithClients' : 'createLesson',
      lessonData,
    )
    if (!response || typeof response.id !== 'string' || !response.id.trim())
      throw new ApiError(502, {
        code: 'INVALID_RESPONSE',
        message: 'Создание занятия не подтверждено. Повторите тот же запрос.',
      })
    if (count && response.clientsAssigned !== count)
      throw new ApiError(502, {
        message: 'Сервис не подтвердил запись всех клиентов. Обновите расписание перед повтором.',
      })
    this.acknowledgeMutation(String(lessonData.requestId))
    return response
  }
  async fetchSchedule(from: string, to: string, branchId?: string, signal?: AbortSignal): Promise<ILesson[]> {
    const data = await this.request<{ items: ILesson[] }>(
      'getSchedule',
      { from, to, ...(branchId ? { branchId } : {}) },
      signal,
    )
    return rowsWithIds(data?.items).map(normalizeLesson) as ILesson[]
  }
  async changeLesson(action: 'updateLesson' | 'cancelLesson' | 'deleteLesson', lessonId: string, payload: JsonObject) {
    return this.stableMutation(
      action,
      lessonId,
      { id: lessonId, ...payload },
      (result: { success?: boolean }) => result?.success === true,
    )
  }
  async createBranch(branchData: { id?: string; name: string; address: string }): Promise<IBranch> {
    return this.stableMutation(
      'createBranch',
      'form',
      branchData,
      (result: IBranch) => typeof result?.id === 'string' && Boolean(result.id.trim()),
    )
  }
  async createCoach(coachData: {
    name: string
    specialty?: string
    initials?: string
    branchId: string
    phone?: string
    birthDate?: string
    username?: string
    password?: string
  }): Promise<ICoach> {
    return this.stableMutation(
      'createCoach',
      'form',
      coachData,
      (result: ICoach) => typeof result?.id === 'string' && Boolean(result.id.trim()),
    )
  }
  async fetchUsers(): Promise<CoachAccount[]> {
    return this.request('getUsers')
  }
  async assignUserBranch(userId: string, branchId: string): Promise<{ success: boolean }> {
    return this.accountMutation('assignUserBranch', userId, { userId, branchId })
  }
  async deactivateUser(userId: string): Promise<{ success: boolean }> {
    return this.accountMutation('deactivateUser', userId, { userId })
  }
  async activateUser(userId: string): Promise<{ success: boolean }> {
    return this.accountMutation('activateUser', userId, { userId })
  }
  async resetCoachPassword(userId: string, newPassword: string): Promise<{ success: boolean }> {
    return this.accountMutation('resetCoachPassword', userId, { userId, newPassword })
  }
  async revokeUserSessions(userId: string): Promise<{ success: boolean }> {
    return this.accountMutation('revokeUserSessions', userId, { userId })
  }
  async linkCoachUser(coachId: string, userId: string): Promise<{ success: boolean }> {
    return this.accountMutation('linkCoachUser', userId, { coachId, userId })
  }
  async deleteCoach(id: string): Promise<void> {
    await this.accountMutation('deleteCoach', id, { id })
  }
  async deleteLesson(id: string): Promise<void> {
    await this.request('deleteLesson', { id })
  }
  async updateClient(id: string, data: JsonObject): Promise<{ success: boolean }> {
    return this.accountMutation('updateClient', id, { id, ...data })
  }

  async assignClientLesson(
    clientId: string,
    lessonId: string,
    requestId = createRequestId(),
    expectedVersion?: number,
  ): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('assignClientLesson', {
      clientId,
      lessonId,
      requestId,
      ...(this.postgresAccounts ? { expectedVersion } : {}),
    })
  }

  async uploadReceipt(
    clientId: string,
    file: File,
    expectedReceiptVersion?: number,
    recovery?: ReceiptAttempt,
  ): Promise<{ success: boolean; receiptVersion?: number; receiptUrl?: string }> {
    if (file.size > 5 * 1024 * 1024) throw new ApiError(413, 'Файл слишком большой (максимум 5 МБ)')
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(file.type)) {
      throw new ApiError(415, 'Разрешены только JPG, PNG и PDF')
    }
    const payload = {
      clientId,
      fileBase64: await fileToBase64(file),
      fileName: file.name,
      mimeType: file.type,
      ...(this.postgresAccounts ? { expectedReceiptVersion } : {}),
    }
    if (!this.postgresAccounts) return this.request('uploadReceipt', payload)
    if (recovery) {
      if (!recovery.metadata) throw new ApiError(409, 'Для старой попытки требуется проверка оператора')
      return this.receiptRecoveryPost(
        clientId,
        {
          ...payload,
          fileName: recovery.metadata.fileName,
          mimeType: recovery.metadata.mimeType,
          expectedReceiptVersion: recovery.metadata.expectedReceiptVersion,
          requestId: recovery.requestId,
        },
        false,
      )
    }
    return this.stableMutation(
      'uploadReceipt',
      clientId,
      payload,
      (result: { success: boolean; receiptVersion?: number }) =>
        result?.success === true && Number.isInteger(result.receiptVersion),
      async (frozen) => {
        try {
          const { response, data } = await fetchJson('/api/receipts/' + encodeURIComponent(clientId), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(frozen),
          })
          if (!response.ok || (data && typeof data === 'object' && 'status' in data && data.status === 'error'))
            throw new ApiError(response.status, data as JsonObject)
          return data as { success: boolean; receiptVersion?: number; receiptUrl?: string }
        } finally {
          this.readGeneration++
          this.inFlightReads.clear()
        }
      },
    )
  }

  async recordAdjustment(
    clientId: string,
    lessonsDelta: number,
    reason: string,
    comment = '',
    requestId?: string,
  ): Promise<{ success: boolean; duplicate?: boolean; client?: Record<string, unknown> }> {
    requestId ||= createRequestId()
    const result = await this.request<{ success: boolean; duplicate?: boolean; client?: Record<string, unknown> }>(
      'recordAdjustment',
      { clientId, lessonsDelta, reason, comment, requestId },
    )
    if (result?.success !== true)
      throw new ApiError(502, { code: 'INVALID_RESPONSE', message: 'Корректировка не подтверждена' })
    this.acknowledgeMutation(requestId)
    return result
  }

  async auditLessonLedger(clientId?: string): Promise<LessonLedgerAudit> {
    return this.request('auditLessonLedger', clientId ? { clientId } : {})
  }

  async repairLessonLedger(
    clientId: string,
    expectedRemainingLessons: number,
    expectedTotalLessons: number,
    reason: string,
    requestId?: string,
    auditFingerprint?: string,
  ): Promise<{ success: boolean; duplicate?: boolean; repaired?: boolean }> {
    return this.request('repairLessonLedger', {
      clientId,
      expectedRemainingLessons,
      expectedTotalLessons,
      reason,
      confirmed: true,
      requestId,
      ...(this.postgresAccounts ? { auditFingerprint } : {}),
    })
  }

  async recordPayment(
    clientId: string,
    amount: number,
    category?: string,
    lessonsPerWeek?: number,
    comment?: string,
    requestId?: string,
  ): Promise<PaymentResult> {
    requestId ||= createRequestId()
    const result = await this.request<PaymentResult>('recordPayment', {
      clientId,
      amount,
      category,
      lessonsPerWeek,
      comment,
      requestId,
    })
    // Invalid acknowledgement is an uncertain outcome, never a reason to add
    // the requested amount locally or retry with a new requestId.
    if (
      result?.success !== true ||
      !result.payment ||
      String(result.payment.clientId) !== clientId ||
      !String(result.payment.id || '').trim() ||
      !validAccountingSnapshot(result.client)
    ) {
      throw new ApiError(502, {
        code: 'INVALID_RESPONSE',
        message: 'Подтверждение платежа неполное. Проверяем историю.',
      })
    }
    this.acknowledgeMutation(requestId)
    return {
      ...result,
      ledgerEntry:
        result.ledgerEntry &&
        String(result.ledgerEntry.id || '').trim() &&
        String(result.ledgerEntry.paymentId) === String(result.payment.id)
          ? result.ledgerEntry
          : undefined,
      audit: validLedgerAudit(result.audit) ? result.audit : undefined,
    }
  }

  async getClientHistory(clientId: string): Promise<ClientHistory> {
    return this.request('getClientHistory', { clientId })
  }

  async getClientAccounting(clientId: string): Promise<ClientAccounting> {
    const result = await this.request<ClientAccounting>('getClientHistory', { clientId, includeAudit: true })
    if (result?.success !== true) {
      throw new ApiError(502, { code: 'INVALID_RESPONSE', message: 'Не удалось загрузить историю платежей.' })
    }
    const history = {
      success: true,
      ...(Array.isArray(result.legacyHistory)
        ? { legacyHistory: result.legacyHistory as { namespace: string; history: JsonObject[] }[] }
        : {}),
      payments: rowsWithIds(result.payments),
      ledger: rowsWithIds(result.ledger),
      ...(result.attendanceHistory !== undefined
        ? { attendanceHistory: rowsWithIds(result.attendanceHistory), attendanceTotal: result.attendanceTotal }
        : {}),
    }
    const client = validAccountingSnapshot(result.client) ? result.client : undefined
    if (Object.prototype.hasOwnProperty.call(result, 'audit')) {
      return {
        ...history,
        client,
        audit: validLedgerAudit(result.audit) ? result.audit : null,
        auditError: validLedgerAudit(result.audit)
          ? undefined
          : {
              code: result.auditError?.code,
              message: result.auditError?.message || 'Не удалось выполнить сверку журнала. Повторите загрузку.',
            },
      }
    }
    // Compatibility with an older GAS deployment only. An explicit audit
    // failure above must retain history without another expensive GAS call.
    try {
      const audit = await this.auditLessonLedger(clientId)
      if (!validLedgerAudit(audit)) throw new Error('Неполный ответ сверки')
      return { ...history, client, audit }
    } catch {
      return {
        ...history,
        client,
        audit: null,
        auditError: { message: 'Не удалось выполнить сверку журнала. Повторите загрузку.' },
      }
    }
  }

  async recordBulkAttendance(
    attendanceList: { clientId: string; status: 'attended' | 'absent'; expectedVersion?: number }[],
    lessonId: string,
    date: string,
    requestId: string = createRequestId(),
    metadata?: { expectedLessonVersion?: number; reason?: string },
  ) {
    if (this.postgresAccounts) {
      // One native transaction, never silently split an atomic packet.
      if (!attendanceList.length || attendanceList.length > 100)
        throw new ApiError(400, { code: 'VALIDATION', message: 'Допустимо от 1 до 100 отметок за одно сохранение' })
      const payload = {
        requestId,
        expectedLessonVersion: metadata?.expectedLessonVersion,
        reason: metadata?.reason || '',
        attendance: attendanceList.map((mark) => ({ ...mark, lessonId, date, isWalkin: false })),
      }
      await this.request('prepareAttendance', payload)
      const response = await this.request<{ success: boolean; results: AttendanceResult[] }>(
        'recordBulkAttendance',
        payload,
      )
      const confirmed = new Set(response?.results?.filter((mark) => mark.success === true).map((mark) => mark.clientId))
      if (
        response?.success !== true ||
        response.results?.length !== attendanceList.length ||
        confirmed.size !== attendanceList.length ||
        attendanceList.some((mark) => !confirmed.has(mark.clientId))
      )
        throw new ApiError(502, {
          code: 'INVALID_RESPONSE',
          message: 'Сохранение не подтверждено. Повторите тот же запрос.',
        })
      // Losing the acknowledgement cannot undo a confirmed write. The durable
      // draft may reappear and be replayed safely after reopening the roster.
      await this.request('acknowledgeAttendance', { requestId }).catch(() => undefined)
      return response
    }
    const results: AttendanceResult[] = []
    for (let offset = 0; offset < attendanceList.length; offset += 100) {
      const chunk = attendanceList.slice(offset, offset + 100)
      let response: { success: boolean; results: AttendanceResult[] }
      try {
        response = await this.request<{
          success: boolean
          results: AttendanceResult[]
        }>('recordBulkAttendance', {
          requestId: `${requestId}:${offset / 100}`,
          attendance: chunk.map((a) => ({
            clientId: a.clientId,
            lessonId,
            date,
            status: a.status,
            isWalkin: false,
          })),
        })
        const confirmedIds = new Set<string>()
        const requestedIds = new Set(chunk.map((mark) => mark.clientId))
        const validResults =
          Array.isArray(response?.results) &&
          response.results.every((result) => {
            if (!result || result.success !== true || confirmedIds.has(result.clientId)) return false
            confirmedIds.add(result.clientId)
            return true
          })
        if (
          !response ||
          response.success !== true ||
          !validResults ||
          requestedIds.size !== chunk.length ||
          response.results.length !== chunk.length ||
          chunk.some((mark) => !confirmedIds.has(mark.clientId))
        ) {
          throw new ApiError(502, {
            code: 'INVALID_RESPONSE',
            message: 'Сервер не подтвердил сохранение всех отметок. Проверьте результат или повторите тот же запрос.',
          })
        }
        // Balances are optional for compatibility with an older GAS deployment.
        // A malformed optional snapshot must never poison the visible counters,
        // or turn an otherwise confirmed write into an uncertain retry.
        response.results = response.results.map((result) => {
          const client = result.client
          const validClient =
            client &&
            Number.isSafeInteger(client.remainingLessons) &&
            Number.isSafeInteger(client.totalLessons) &&
            client.remainingLessons >= 0 &&
            client.totalLessons >= client.remainingLessons &&
            ['Активен', 'Пауза', 'Архив'].includes(client.status)
          return {
            ...result,
            client: validClient
              ? { remainingLessons: client.remainingLessons, totalLessons: client.totalLessons, status: client.status }
              : undefined,
          }
        })
      } catch (error) {
        if (error && typeof error === 'object' && results.length > 0) {
          Object.assign(error, { attendanceOutcomeUnknown: true })
        }
        throw error
      }
      results.push(...response.results)
    }
    return { success: results.every((item) => item.success), results }
  }

  async recordAttendance(
    clientId: string,
    lessonId: string,
    status: 'attended' | 'absent',
    date: string,
  ): Promise<{ success: boolean }> {
    const requestId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return this.request<{ success: boolean }>('recordAttendance', { clientId, lessonId, status, date, requestId })
  }

  async getBranches(): Promise<IBranch[]> {
    return this.fetchBranches()
  }
  async receiptAttempts(clientId: string, signal?: AbortSignal): Promise<ReceiptAttempt[]> {
    const { response, data } = await fetchJson('/api/receipts/' + encodeURIComponent(clientId) + '/attempts', {
      credentials: 'same-origin',
      signal,
    })
    if (!response.ok) throw new ApiError(response.status, data)
    if (
      !data ||
      typeof data !== 'object' ||
      !('attempts' in data) ||
      !Array.isArray(data.attempts) ||
      data.attempts.length > 20 ||
      !data.attempts.every((value: unknown) => {
        if (!value || typeof value !== 'object') return false
        const row = value as ReceiptAttempt,
          metadata = row.metadata
        return (
          typeof row.requestId === 'string' &&
          row.requestId.length > 0 &&
          row.requestId.length <= 150 &&
          typeof row.resumable === 'boolean' &&
          typeof row.createdAt === 'string' &&
          (metadata === null ||
            (metadata &&
              metadata.clientId === clientId &&
              Number.isInteger(metadata.expectedReceiptVersion) &&
              metadata.expectedReceiptVersion >= 0 &&
              typeof metadata.fileName === 'string' &&
              metadata.fileName.length > 0 &&
              metadata.fileName.length <= 200 &&
              ['image/png', 'image/jpeg', 'application/pdf'].includes(metadata.mimeType) &&
              /^[a-f0-9]{64}$/.test(metadata.sha256) &&
              Number.isInteger(metadata.sizeBytes) &&
              metadata.sizeBytes > 0 &&
              metadata.sizeBytes <= 5 * 1024 * 1024)) &&
          (!row.resumable || metadata !== null)
        )
      }) ||
      new Set(data.attempts.map((row: ReceiptAttempt) => row.requestId)).size !== data.attempts.length
    )
      throw new ApiError(502, 'Не удалось проверить незавершённые загрузки')
    return data.attempts as ReceiptAttempt[]
  }
  async receiptRecoveryPost(
    clientId: string,
    payload: JsonObject,
    attemptRoute = true,
  ): Promise<{ success: boolean; alreadyConfirmed?: boolean }> {
    const pending = this.accountAttempts.get('uploadReceipt:' + clientId)
    const { response, data } = await fetchJson(
      '/api/receipts/' + encodeURIComponent(clientId) + (attemptRoute ? '/attempts' : ''),
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )
    if (!response.ok) throw new ApiError(response.status, data)
    if (!data || typeof data !== 'object' || !('success' in data) || data.success !== true)
      throw new ApiError(502, 'Сохранение не подтверждено. Повторите исходную попытку.')
    if (this.accountAttempts.get('uploadReceipt:' + clientId) === pending && pending?.requestId === payload.requestId)
      this.accountAttempts.delete('uploadReceipt:' + clientId)
    this.readGeneration++
    this.inFlightReads.clear()
    return data as { success: boolean; alreadyConfirmed?: boolean }
  }
  async getCoaches(): Promise<ICoach[]> {
    return this.fetchCoaches()
  }
  async getLessons(): Promise<ReturnType<typeof normalizeLesson>[]> {
    return this.fetchLessons()
  }
  async getClients(): Promise<ReturnType<typeof normalizeClient>[]> {
    return this.fetchClients()
  }
}

export const apiClient = new ApiClient()
