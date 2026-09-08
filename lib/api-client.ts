import { IBranch, ICoach, IClient, ILesson, CreateClientDto } from '@/store/models'

const GAS_URL = 'https://script.google.com/macros/s/AKfycby_97Oww186uc2aYfvdRh7RWWeERasRC0AqEMPstNoAaj56djvqF-h72FMmWgP6CeuL4Q/exec'

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
  async login(username: string, password: string): Promise<{ user: any; token: string }> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'login', username, password }),
    })
    
    if (!response.ok) throw new ApiError(response.status, 'Failed to login')
    return response.json()
  }

  async fetchClients(): Promise<IClient[]> {
    const response = await fetch(GAS_URL + '?sheet=Клиенты')
    if (!response.ok) throw new ApiError(response.status, 'Failed to fetch clients')
    return response.json()
  }

  async createClient(clientData: CreateClientDto): Promise<IClient> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...clientData, action: 'createClient' }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to create client')
    return response.json()
  }

  async updateClient(id: string, data: Partial<IClient>): Promise<IClient> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...data, id, action: 'updateClient' }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to update client')
    return response.json()
  }

  async deleteClient(id: string): Promise<void> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ id, action: 'deleteClient' }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to delete client')
  }

  async fetchBranches(): Promise<IBranch[]> {
    const response = await fetch(GAS_URL + '?sheet=Филиалы')
    if (!response.ok) throw new ApiError(response.status, 'Failed to fetch branches')
    return response.json()
  }

  async fetchCoaches(): Promise<ICoach[]> {
    const response = await fetch(GAS_URL + '?sheet=Тренеры')
    if (!response.ok) throw new ApiError(response.status, 'Failed to fetch coaches')
    return response.json()
  }

  async fetchLessons(): Promise<ILesson[]> {
    const response = await fetch(GAS_URL + '?sheet=Расписание')
    if (!response.ok) throw new ApiError(response.status, 'Failed to fetch lessons')
    return response.json()
  }

  async createBranch(branchData: { name: string; address: string }): Promise<IBranch> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...branchData, action: 'createBranch' }),
    })
    
    if (!response.ok) throw new ApiError(response.status, 'Failed to create branch')
    return response.json()
  }

  async createCoach(coachData: any): Promise<ICoach> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...coachData, action: 'createCoach' }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to create coach')
    return response.json()
  }

  async updateCoach(id: string, coachData: any): Promise<ICoach> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...coachData, id, action: 'updateCoach' }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to update coach')
    return response.json()
  }

  async deleteCoach(id: string): Promise<void> {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ id, action: 'deleteCoach' }),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to delete coach')
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
      headers: { "Content-Type": "application/json" }
    });
    return response.json();
  }

  async markAttendance(clientId: string) {
    const response = await fetch(GAS_URL, {
      method: "POST",
      body: JSON.stringify({
        action: "markAttendance",
        clientId
      }),
      headers: { "Content-Type": "application/json" }
    });
    return response.json();
  }

  async getBranches(): Promise<IBranch[]> { return this.fetchBranches() }
  async getCoaches(): Promise<ICoach[]> { return this.fetchCoaches() }
  async getLessons(): Promise<ILesson[]> { return this.fetchLessons() }
  async getClients(): Promise<IClient[]> { return this.fetchClients() }
}
}

export const apiClient = new ApiClient()
