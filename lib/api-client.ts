import { IBranch, ICoach, IClient, ILesson, CreateClientDto, RegisterCredentials } from '@/store/models'

const API_ROUTE = '/api/crm'

export class ApiError extends Error {
  constructor(public status: number | string, public data: any) {
    super(`API Error: ${status}`)
  }
}

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = error => reject(error);
  });
};

class ApiClient {
  private async request(action: string, payload: any = {}): Promise<any> {
    const response = await fetch(API_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    })
    
    if (!response.ok) throw new ApiError(response.status, 'API Request failed')
    const data = await response.json()
    if (data.status === 'error') throw new ApiError(500, data.message)
    return data
  }

  async login(username: string, password: string): Promise<{ user: any; token: string }> {
    return this.request('login', { username, password })
  }

  async register(credentials: RegisterCredentials): Promise<any> {
    return this.request('register', credentials)
  }

  async fetchClients(): Promise<IClient[]> {
    return this.request('getSheet', { sheet: 'Клиенты' }).then(data => 
      (Array.isArray(data) ? data : []).map((c: any) => ({ 
        ...c, 
        id: String(c.id),
        branchId: c.branchId ? String(c.branchId) : ''
      }))
    );
  }

  async createClient(clientData: CreateClientDto): Promise<IClient> {
    return this.request('createClient', clientData)
  }

  async updateClient(id: string, data: Partial<IClient>): Promise<IClient> {
    return this.request('updateClient', { ...data, id })
  }

  async deleteClient(id: string): Promise<void> {
    await this.request('deleteClient', { id })
  }

  async fetchBranches(): Promise<IBranch[]> {
    return this.request('getSheet', { sheet: 'Филиалы' }).then(data => 
      (Array.isArray(data) ? data : []).map((b: any) => ({ ...b, id: String(b.id) }))
    );
  }

  async fetchCoaches(): Promise<ICoach[]> {
    return this.request('getSheet', { sheet: 'Тренеры' }).then(data => 
      (Array.isArray(data) ? data : []).map((c: any) => ({ 
        ...c, 
        id: String(c.id),
        branchId: c.branchId ? String(c.branchId) : ''
      }))
    );
  }

  async fetchLessons(): Promise<ILesson[]> {
    return this.request('getSheet', { sheet: 'Расписание' }).then(data => 
      (Array.isArray(data) ? data : []).map((l: any) => ({ 
        ...l, 
        id: String(l.id),
        branchId: l.branchId ? String(l.branchId) : ''
      }))
    );
  }

  async createLesson(lessonData: any): Promise<ILesson> {
    return this.request('createLesson', lessonData)
  }

  async createBranch(branchData: { id?: string; name: string; address: string }): Promise<IBranch> {
    return this.request('createBranch', branchData)
  }

  async createCoach(coachData: any): Promise<ICoach> {
    return this.request('createCoach', coachData)
  }

  async updateCoach(id: string, coachData: any): Promise<ICoach> {
    return this.request('updateCoach', { ...coachData, id })
  }

  async deleteCoach(id: string): Promise<void> {
    await this.request('deleteCoach', { id })
  }

  async deleteLesson(id: string): Promise<void> {
    await this.request('deleteLesson', { id })
  }

  async updateClientAPI(id: string, data: any): Promise<any> {
    return this.request('updateClient', { id, ...data })
  }

  async uploadReceipt(clientId: string, file: File, lessonsCount: number) {
    const fileBase64 = await fileToBase64(file);
    return this.request('uploadReceipt', {
      clientId,
      fileBase64,
      fileName: file.name,
      mimeType: file.type,
      lessonsCount
    })
  }

  async recordBulkAttendance(attendanceList: { clientId: string, status: 'attended' | 'absent' }[], lessonId: string, date: string) {
    return this.request('recordBulkAttendance', { attendanceList, lessonId, date })
  }

  async recordAttendance(clientId: string, lessonId: string, status: 'attended' | 'absent', date: string): Promise<any> {
    return this.request('recordAttendance', { clientId, lessonId, status, date })
  }

  async getBranches(): Promise<IBranch[]> { return this.fetchBranches() }
  async getCoaches(): Promise<ICoach[]> { return this.fetchCoaches() }
  async getLessons(): Promise<ILesson[]> { return this.fetchLessons() }
  async getClients(): Promise<IClient[]> { return this.fetchClients() }
}

export const apiClient = new ApiClient()
