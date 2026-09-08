import { IBranch, ICoach, IClient, ILesson, CreateClientDto } from '@/store/models'

const GAS_URL = 'https://script.google.com/macros/s/AKfycby_97Oww186uc2aYfvdRh7RWWeERasRC0AqEMPstNoAaj56djvqF-h72FMmWgP6CeuL4Q/exec'

export class ApiError extends Error {
  constructor(public status: number | string, public data: any) {
    super(`API Error: ${status}`)
  }
}

export const fetchClients = async (): Promise<IClient[]> => {
  const response = await fetch(GAS_URL + '?sheet=Клиенты')
  if (!response.ok) throw new ApiError(response.status, 'Failed to fetch clients')
  return response.json()
}

export const createClient = async (clientData: CreateClientDto): Promise<IClient> => {
  const response = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(clientData),
  })
  
  if (!response.ok) throw new ApiError(response.status, 'Failed to create client')
  return response.json()
}

export const fetchBranches = async (): Promise<IBranch[]> => {
  const response = await fetch(GAS_URL + '?sheet=Филиалы')
  if (!response.ok) throw new ApiError(response.status, 'Failed to fetch branches')
  return response.json()
}

export const fetchCoaches = async (): Promise<ICoach[]> => {
  return []
}

export const fetchLessons = async (): Promise<ILesson[]> => {
  return []
}

export const createBranch = async (branchData: { name: string; address: string }): Promise<IBranch> => {
  const response = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...branchData, action: 'createBranch' }),
  })
  
  if (!response.ok) throw new ApiError(response.status, 'Failed to create branch')
  return response.json()
}

// Старый класс для обратной совместимости (RootStore)
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
  async getBranches(): Promise<IBranch[]> { return fetchBranches() }
  async getCoaches(): Promise<ICoach[]> { return fetchCoaches() }
  async getLessons(): Promise<ILesson[]> { return fetchLessons() }
  async getClients(): Promise<IClient[]> { return fetchClients() }
  async createClient(data: CreateClientDto): Promise<IClient> { return createClient(data) }
  async createBranch(data: { name: string; address: string }): Promise<IBranch> { return createBranch(data) }
  async updateClient(id: string, data: any): Promise<IClient> { throw new Error('Not implemented') }
  async deleteClient(id: string): Promise<void> { throw new Error('Not implemented') }
  async createCoach(data: any): Promise<ICoach> { throw new Error('Not implemented') }
  async updateCoach(id: string, data: any): Promise<ICoach> { throw new Error('Not implemented') }
  async deleteCoach(id: string): Promise<void> { throw new Error('Not implemented') }
}

export const apiClient = new ApiClient()
