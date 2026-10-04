import { IBranch, ICoach, IClient, ILesson, CreateClientDto, UserRole } from '@/store/models'
import { devLog } from './dev-log'
import { normalizeLesson, normalizeClient } from './normalizers'

const API_ROUTE = '/api/crm'
const AUTH_ROUTE = '/api/auth'

const MUTATING_ACTIONS = new Set([
  'assignUserBranch',
  'deactivateUser',
  'activateUser',
  'resetCoachPassword',
  'linkCoachUser',
  'createClient',
  'createLesson',
  'createBranch',
  'createCoach',
  'updateClient',
  'assignClientLesson',
  'updateLesson',
  'deleteClient',
  'deleteCoach',
  'deleteLesson',
  'recordAttendance',
  'recordBulkAttendance',
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

export type CoachAccount = {
  id: string
  username: string
  role: 'coach'
  branchId: string | null
  status: 'Активен' | 'Отключен'
  disabledAt: string | null
  disabledBy: string | null
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

type JsonObject = Record<string, unknown>

export type LessonRosterClient = {
  id: string
  childName: string
  parentName: string
  category: string
  status: string
  remainingLessons: number
  mark: 'attended' | 'absent' | null
}

export type LessonRoster = { lessonId: string; date: string; clients: LessonRosterClient[] }

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
}

export type LessonLedgerAudit = {
  success: boolean
  checked: number
  discrepancies: LessonLedgerDiscrepancy[]
}

class ApiClient {
  private readonly inFlightReads = new Map<string, Promise<unknown>>()

  private async request<T = unknown>(action: string, payload: JsonObject = {}, signal?: AbortSignal): Promise<T> {
    const isMutation = MUTATING_ACTIONS.has(action)
    const requestPayload =
      isMutation && payload.requestId === undefined ? { ...payload, requestId: createRequestId() } : payload

    const execute = async (): Promise<T> => {
      devLog('api.request.start', { action })
      const response = await fetch(API_ROUTE, {
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

      const contentType = response.headers.get('content-type') ?? ''
      let data: unknown
      try {
        data = contentType.includes('application/json')
          ? await response.json()
          : { status: 'error', code: 'SERVICE_UNAVAILABLE', message: 'Сервис временно недоступен' }
      } catch {
        data = { status: 'error', message: 'Некорректный ответ API' }
      }

      const object = data && typeof data === 'object' ? (data as JsonObject) : null
      if (!response.ok) {
        throw new ApiError(
          response.status,
          object ?? { status: 'error', message: 'Ошибка запроса (' + response.status + ')' },
        )
      }
      if (object?.status === 'error') throw new ApiError(500, object)
      return data as T
    }

    if (isMutation) return execute()

    const readKey = `${action}:${JSON.stringify(requestPayload)}`
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
    const response = await fetch(`${AUTH_ROUTE}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload ?? {}),
    })
    devLog('auth.request.response', { path, status: response.status, ok: response.ok })
    const data = (await response
      .json()
      .catch(() => ({ status: 'error', message: 'Некорректный ответ API' }))) as unknown
    const object = data && typeof data === 'object' ? (data as JsonObject) : null
    if (!response.ok || object?.status === 'error') {
      throw new ApiError(
        response.status,
        object ?? { status: 'error', message: 'Ошибка запроса (' + response.status + ')' },
      )
    }
    return data as T
  }

  async login(username: string, password: string): Promise<{ user: ApiUser }> {
    return this.authRequest('login', { username, password })
  }

  async session(): Promise<{ authenticated: boolean; user: ApiUser | null }> {
    const response = await fetch(`${AUTH_ROUTE}/session`, { credentials: 'same-origin', cache: 'no-store' })
    devLog('auth.session.response', { status: response.status, ok: response.ok })
    return response.json() as Promise<{ authenticated: boolean; user: ApiUser | null }>
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

  async createClient(clientData: CreateClientDto): Promise<IClient> {
    return this.request<IClient>('createClient', clientData as unknown as JsonObject)
  }

  async deleteClient(id: string): Promise<void> {
    await this.request('deleteClient', { id })
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
    return this.request<LessonRoster>('getLessonRoster', { lessonId, date }, signal)
  }

  async fetchLessons(signal?: AbortSignal, branchId?: string): Promise<ReturnType<typeof normalizeLesson>[]> {
    const data = await this.request<unknown[]>(
      'getSheet',
      { sheet: 'Расписание', ...(branchId ? { branchId } : {}) },
      signal,
    )
    return (Array.isArray(data) ? data : []).map(normalizeLesson)
  }

  async fetchBootstrapData(signal?: AbortSignal, branchId?: string): Promise<BootstrapData> {
    try {
      const data = await this.request<{ branches?: unknown[]; coaches?: unknown[]; lessons?: unknown[] }>(
        'getBootstrapData',
        branchId ? { branchId } : {},
        signal,
      )
      return {
        branches: (Array.isArray(data.branches) ? data.branches : []).map((raw) => {
          const value = raw as JsonObject
          return { ...value, id: String(value.id) } as IBranch
        }),
        coaches: (Array.isArray(data.coaches) ? data.coaches : []).map((raw) => {
          const value = raw as JsonObject
          return {
            ...value,
            id: String(value.id),
            branchId: value.branchId ? String(value.branchId) : '',
          } as ICoach
        }),
        lessons: (Array.isArray(data.lessons) ? data.lessons : []).map(normalizeLesson),
      }
    } catch (error) {
      // Keep rolling deployments usable: an older GAS version does not know
      // getBootstrapData and reports it as NOT_FOUND. Once GAS is updated,
      // the fast single-request path above is used automatically.
      if (!(error instanceof ApiError) || (error.status !== 404 && error.code !== 'NOT_FOUND')) throw error
      const [branches, coaches, lessons] = await Promise.all([
        this.fetchBranches(signal),
        this.fetchCoaches(signal, branchId),
        this.fetchLessons(signal, branchId),
      ])
      return { branches, coaches, lessons }
    }
  }

  async createLesson(lessonData: JsonObject): Promise<ILesson> {
    return this.request<ILesson>('createLesson', lessonData)
  }
  async createBranch(branchData: { id?: string; name: string; address: string }): Promise<IBranch> {
    return this.request<IBranch>('createBranch', branchData)
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
    return this.request<ICoach>('createCoach', coachData)
  }
  async fetchUsers(): Promise<CoachAccount[]> {
    return this.request('getUsers')
  }
  async assignUserBranch(userId: string, branchId: string): Promise<{ success: boolean }> {
    return this.request('assignUserBranch', { userId, branchId })
  }
  async deactivateUser(userId: string): Promise<{ success: boolean }> {
    return this.request('deactivateUser', { userId })
  }
  async activateUser(userId: string): Promise<{ success: boolean }> {
    return this.request('activateUser', { userId })
  }
  async resetCoachPassword(userId: string, newPassword: string): Promise<{ success: boolean }> {
    return this.request('resetCoachPassword', { userId, newPassword })
  }
  async linkCoachUser(coachId: string, userId: string): Promise<{ success: boolean }> {
    return this.request('linkCoachUser', { coachId, userId })
  }
  async deleteCoach(id: string): Promise<void> {
    await this.request('deleteCoach', { id })
  }
  async deleteLesson(id: string): Promise<void> {
    await this.request('deleteLesson', { id })
  }
  async updateClient(id: string, data: JsonObject): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('updateClient', { id, ...data })
  }

  async assignClientLesson(
    clientId: string,
    lessonId: string,
    requestId = createRequestId(),
  ): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('assignClientLesson', { clientId, lessonId, requestId })
  }

  async uploadReceipt(clientId: string, file: File): Promise<{ success: boolean }> {
    if (file.size > 5 * 1024 * 1024) throw new ApiError(413, 'Файл слишком большой (максимум 5 МБ)')
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(file.type)) {
      throw new ApiError(415, 'Разрешены только JPG, PNG и PDF')
    }
    return this.request<{ success: boolean }>('uploadReceipt', {
      clientId,
      fileBase64: await fileToBase64(file),
      fileName: file.name,
      mimeType: file.type,
    })
  }

  async recordAdjustment(
    clientId: string,
    lessonsDelta: number,
    reason: string,
    comment = '',
    requestId?: string,
  ): Promise<{ success: boolean; duplicate?: boolean; client?: Record<string, unknown> }> {
    return this.request('recordAdjustment', { clientId, lessonsDelta, reason, comment, requestId })
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
  ): Promise<{ success: boolean; duplicate?: boolean; repaired?: boolean }> {
    return this.request('repairLessonLedger', {
      clientId,
      expectedRemainingLessons,
      expectedTotalLessons,
      reason,
      confirmed: true,
      requestId,
    })
  }

  async recordPayment(
    clientId: string,
    amount: number,
    category?: string,
    lessonsPerWeek?: number,
    comment?: string,
    requestId?: string,
  ): Promise<{ success: boolean; payment: Record<string, unknown>; client: Record<string, unknown> }> {
    return this.request('recordPayment', { clientId, amount, category, lessonsPerWeek, comment, requestId })
  }

  async getClientHistory(clientId: string): Promise<{
    success: boolean
    payments: Array<Record<string, unknown>>
    ledger: Array<Record<string, unknown>>
  }> {
    return this.request('getClientHistory', { clientId })
  }

  async recordBulkAttendance(
    attendanceList: { clientId: string; status: 'attended' | 'absent' }[],
    lessonId: string,
    date: string,
    requestId: string = createRequestId(),
  ) {
    const results: Array<{ clientId: string; success: boolean; message?: string }> = []
    for (let offset = 0; offset < attendanceList.length; offset += 100) {
      const chunk = attendanceList.slice(offset, offset + 100)
      const response = await this.request<{
        success: boolean
        results: Array<{ clientId: string; success: boolean; message?: string }>
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
