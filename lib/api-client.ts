import { IBranch, ICoach, IClient, ILesson, CreateClientDto, RegisterCredentials, UserRole } from '@/store/models'
import { normalizeLesson, normalizeClient } from './normalizers'

const API_ROUTE = '/api/crm'
const AUTH_ROUTE = '/api/auth'

export type ApiUser = {
  id: string | number
  username: string
  role: UserRole
  branchId: string | number | null
}

export class ApiError extends Error {
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

export type ClientsPage = {
  items: ReturnType<typeof normalizeClient>[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

class ApiClient {
  private async request<T = unknown>(action: string, payload: JsonObject = {}, signal?: AbortSignal): Promise<T> {
    const response = await fetch(API_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action, payload }),
      signal,
    })

    const contentType = response.headers.get('content-type') ?? ''
    let data: unknown
    try {
      data = contentType.includes('application/json')
        ? await response.json()
        : { status: 'error', message: (await response.text()).slice(0, 300) }
    } catch {
      data = { status: 'error', message: 'Некорректный ответ API' }
    }

    const object = data && typeof data === 'object' ? (data as JsonObject) : null
    if (!response.ok) throw new ApiError(response.status, object?.message ?? `API request failed (${response.status})`)
    if (object?.status === 'error') throw new ApiError(500, object.message ?? 'API request failed')
    return data as T
  }

  private async authRequest<T>(path: string, payload?: JsonObject): Promise<T> {
    const response = await fetch(`${AUTH_ROUTE}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload ?? {}),
    })
    const data = (await response
      .json()
      .catch(() => ({ status: 'error', message: 'Некорректный ответ API' }))) as unknown
    const object = data && typeof data === 'object' ? (data as JsonObject) : null
    if (!response.ok || object?.status === 'error') {
      throw new ApiError(response.status, object?.message ?? `API request failed (${response.status})`)
    }
    return data as T
  }

  async login(username: string, password: string): Promise<{ user: ApiUser }> {
    return this.authRequest('login', { username, password })
  }

  async register(credentials: RegisterCredentials): Promise<{ status: string }> {
    return this.authRequest('register', {
      username: credentials.username,
      password: credentials.password,
    })
  }

  async session(): Promise<{ authenticated: boolean; user: ApiUser | null }> {
    const response = await fetch(`${AUTH_ROUTE}/session`, { credentials: 'same-origin', cache: 'no-store' })
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
  ): Promise<ClientsPage> {
    const data = await this.request<{
      items?: unknown[]
      total?: number
      page?: number
      pageSize?: number
      hasMore?: boolean
    }>(
      'getClients',
      { page, pageSize, ...(branchId ? { branchId } : {}), ...(query ? { query } : {}), ...(status ? { status } : {}) },
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

  async createClient(clientData: CreateClientDto): Promise<IClient> {
    return this.request<IClient>('createClient', clientData as unknown as JsonObject)
  }

  async updateClient(id: string, data: Partial<IClient>): Promise<IClient> {
    return this.request<IClient>('updateClient', { ...data, id } as JsonObject)
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

  async fetchLessons(signal?: AbortSignal, branchId?: string): Promise<ReturnType<typeof normalizeLesson>[]> {
    const data = await this.request<unknown[]>(
      'getSheet',
      { sheet: 'Расписание', ...(branchId ? { branchId } : {}) },
      signal,
    )
    return (Array.isArray(data) ? data : []).map(normalizeLesson)
  }

  async createLesson(lessonData: JsonObject): Promise<ILesson> {
    return this.request<ILesson>('createLesson', lessonData)
  }
  async createBranch(branchData: { id?: string; name: string; address: string }): Promise<IBranch> {
    return this.request<IBranch>('createBranch', branchData)
  }
  async createCoach(coachData: JsonObject): Promise<ICoach> {
    return this.request<ICoach>('createCoach', coachData)
  }
  async createUser(userData: { username: string; password: string; role: 'admin' | 'coach'; branchId?: string }): Promise<{
    status: string
    user?: { username: string; role: 'admin' | 'coach'; branchId: string | null }
  }> {
    return this.request('createUser', userData as JsonObject)
  }
  async fetchUsers(): Promise<Array<{ id: string; username: string; role: UserRole; branchId: string | null }>> {
    return this.request('getUsers')
  }
  async assignUserBranch(userId: string, branchId: string): Promise<{ success: boolean }> {
    return this.request('assignUserBranch', { userId, branchId })
  }
  async updateCoach(id: string, coachData: JsonObject): Promise<ICoach> {
    return this.request<ICoach>('updateCoach', { ...coachData, id })
  }
  async deleteCoach(id: string): Promise<void> {
    await this.request('deleteCoach', { id })
  }
  async deleteLesson(id: string): Promise<void> {
    await this.request('deleteLesson', { id })
  }
  async updateClientAPI(id: string, data: JsonObject): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('updateClient', { id, ...data })
  }

  async uploadReceipt(clientId: string, file: File, lessonsCount: number): Promise<{ success: boolean }> {
    if (file.size > 5 * 1024 * 1024) throw new ApiError(413, 'Файл слишком большой (максимум 5 МБ)')
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(file.type)) {
      throw new ApiError(415, 'Разрешены только JPG, PNG и PDF')
    }
    return this.request<{ success: boolean }>('uploadReceipt', {
      clientId,
      fileBase64: await fileToBase64(file),
      fileName: file.name,
      mimeType: file.type,
      lessonsCount,
    })
  }

  async addLessons(clientId: string, count: number): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('addLessons', { clientId, lessonsCount: count })
  }

  async recordBulkAttendance(
    attendanceList: { clientId?: string; visitorName?: string; status: 'attended' | 'absent'; isWalkin?: boolean }[],
    lessonId: string,
    date: string,
  ) {
    const requestId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return this.request<{ success: boolean; results: Array<{ clientId: string; success: boolean }> }>(
      'recordBulkAttendance',
      {
        requestId,
        attendance: attendanceList.map((a) => ({
          clientId: a.clientId,
          visitorName: a.visitorName,
          lessonId,
          date,
          status: a.status,
          isWalkin: a.isWalkin || false,
        })),
      },
    )
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
