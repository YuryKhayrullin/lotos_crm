import { IBranch, ICoach, IClient, ILesson, CreateClientDto } from '@/store/models'

const GAS_URL = '/api/crm'

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

const getHeaders = () => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('crm_token') : null;
  console.log('DEBUG getHeaders - token found:', !!token);
  const headers: HeadersInit = { 'Content-Type': 'text/plain;charset=utf-8' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    console.warn('DEBUG getHeaders - No token found in localStorage');
  }
  return headers;
};

class ApiClient {
  async login(username: string, password: string): Promise<{ user: any; token: string }> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'login', username, password }),
    })
    
    if (!response.ok) throw new ApiError(response.status, 'Failed to login')
    return response.json()
  }

  async register(username: string, password: string): Promise<any> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'register', username, password }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to register')
    return response.json()
  }

  async fetchClients(): Promise<IClient[]> {
    const response = await fetch(GAS_URL + '?sheet=Клиенты', { headers: getHeaders() })
    if (!response.ok) throw new ApiError(response.status, 'Failed to fetch clients')
    const data = await response.json();
    return (Array.isArray(data) ? data : []).map((c: any) => ({ 
      ...c, 
      id: String(c.id),
      branchId: c.branchId ? String(c.branchId) : ''
    }));
  }

  async createClient(clientData: CreateClientDto): Promise<IClient> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ ...clientData, action: 'createClient' }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to create client')
    return response.json()
  }

  async updateClient(id: string, data: Partial<IClient>): Promise<IClient> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ ...data, id, action: 'updateClient' }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to update client')
    return response.json()
  }

  async deleteClient(id: string): Promise<void> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ id, action: 'deleteClient' }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to delete client')
  }

  async fetchBranches(): Promise<IBranch[]> {
    const response = await fetch(GAS_URL + '?sheet=Филиалы', { headers: getHeaders() })
    if (!response.ok) throw new ApiError(response.status, 'Failed to fetch branches')
    
    const data = await response.json();
    
    return (Array.isArray(data) ? data : []).map((b: any) => ({ ...b, id: String(b.id) }));
  }

  async fetchCoaches(): Promise<ICoach[]> {
    const response = await fetch(GAS_URL + '?sheet=Тренеры', { headers: getHeaders() })
    if (!response.ok) throw new ApiError(response.status, 'Failed to fetch coaches')
    const data = await response.json();
    return (Array.isArray(data) ? data : []).map((c: any) => ({ 
      ...c, 
      id: String(c.id),
      branchId: c.branchId ? String(c.branchId) : ''
    }));
  }

  async fetchLessons(): Promise<ILesson[]> {
    const response = await fetch(GAS_URL + '?sheet=Расписание', { headers: getHeaders() })
    if (!response.ok) throw new ApiError(response.status, 'Failed to fetch lessons')
    const data = await response.json();
    return (Array.isArray(data) ? data : []).map((l: any) => ({ 
      ...l, 
      id: String(l.id),
      branchId: l.branchId ? String(l.branchId) : ''
    }));
  }



  async createLesson(lessonData: any): Promise<ILesson> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ ...lessonData, action: 'createLesson' }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to create lesson')
    return response.json()
  }


  async createBranch(branchData: { id?: string; name: string; address: string }): Promise<IBranch> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ ...branchData, action: 'createBranch' }),
    })
    
    if (!response.ok) throw new ApiError(response.status, 'Failed to create branch')
    return response.json()
  }

  async createCoach(coachData: any): Promise<ICoach> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ ...coachData, action: 'createCoach' }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to create coach')
    return response.json()
  }

  async updateCoach(id: string, coachData: any): Promise<ICoach> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ ...coachData, id, action: 'updateCoach' }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to update coach')
    return response.json()
  }

  async deleteCoach(id: string): Promise<void> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ id, action: 'deleteCoach' }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to delete coach')
  }

  async updateClientAPI(id: string, data: any): Promise<any> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ action: 'updateClient', id, ...data }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to update client via API')
    return response.json()
  }

  async uploadReceipt(clientId: string, file: File, lessonsCount: number) {
    const fileBase64 = await fileToBase64(file);
    const response = await fetch(GAS_URL, {
      method: "POST",
      body: JSON.stringify({
        action: "uploadReceipt",
        clientId,
        fileBase64,
        fileName: file.name,
        mimeType: file.type,
        lessonsCount
      }),
      headers: getHeaders()
    });
    return response.json()
  }

  async recordBulkAttendance(attendanceList: { clientId: string, status: 'attended' | 'absent' }[], lessonId: string, date: string) {
    const response = await fetch(GAS_URL, {
      method: "POST",
      body: JSON.stringify({
        action: "recordBulkAttendance",
        attendanceList,
        lessonId,
        date
      }),
      headers: getHeaders()
    });
    return response.json()
  }

  async recordAttendance(clientId: string, lessonId: string, status: 'attended' | 'absent', date: string) {
    const response = await fetch(GAS_URL, {
      method: "POST",
      body: JSON.stringify({
        action: "recordAttendance",
        clientId,
        lessonId,
        status,
        date
      }),
      headers: getHeaders()
    });
    return response.json()
  }

  async getBranches(): Promise<IBranch[]> { return this.fetchBranches() }
  async getCoaches(): Promise<ICoach[]> { return this.fetchCoaches() }
  async getLessons(): Promise<ILesson[]> { return this.fetchLessons() }
  async getClients(): Promise<IClient[]> { return this.fetchClients() }
}

export const apiClient = new ApiClient()
