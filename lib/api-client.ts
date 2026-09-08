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
      body: JSON.stringify(clientData),
    })
    if (!response.ok) throw new ApiError(response.status, 'Failed to create client')
    return response.json()
  }

  async fetchBranches(): Promise<IBranch[]> {
    const response = await fetch(GAS_URL + '?sheet=Филиалы')
    if (!response.ok) throw new ApiError(response.status, 'Failed to fetch branches')
    return response.json()
  }

  async fetchCoaches(): Promise<ICoach[]> {
    return []
  }

  async fetchLessons(): Promise<ILesson[]> {
    return []
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
  async createClient(data: CreateClientDto): Promise<IClient> { return this.createClient(data) }
  async deleteClient(id: string): Promise<void> { throw new Error('Not implemented') }
  async createCoach(data: any): Promise<ICoach> { throw new Error('Not implemented') }
  async updateCoach(id: string, data: any): Promise<ICoach> { throw new Error('Not implemented') }
  async deleteCoach(id: string): Promise<void> { throw new Error('Not implemented') }
}

export const apiClient = new ApiClient()
