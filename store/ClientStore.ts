import { types, flow, Instance } from 'mobx-state-tree'
import { ClientModel, IClient, CreateClientDto } from './models/Client'
import { fetchClients, createClient } from '@/lib/api-client'

export const ClientStore = types
  .model('ClientStore', {
    clients: types.optional(types.array(ClientModel), []),
    isLoading: types.optional(types.boolean, false),
    error: types.maybeNull(types.string),
  })
  .actions((self) => ({
    loadClients: flow(function* () {
      self.isLoading = true
      self.error = null
      try {
        const rawData = yield fetchClients()
        console.log('RAW API RESPONSE:', rawData)
        
        // Преобразование данных перед записью в стор с безопасными значениями по умолчанию
        const validStatuses = ['Активен', 'Пауза', 'Архив'];
        const formattedClients = (rawData as any[]).map(client => {
          console.log('Mapping client:', client)
          return {
            id: String(client.id || ''),
            childName: String(client.childName || 'Без имени'),
            parentName: String(client.parentName || 'Без имени'),
            phone: String(client.phone || 'Нет'),
            email: String(client.email || 'Нет'),
            birthDate: String(client.birthDate || '01.01.2000'),
            age: String(client.age || '0 лет'),
            branchId: String(client.branchId || ''), // Убрали дефолтное значение '1', берем из API
            status: validStatuses.includes(client.status) ? client.status : 'Активен',
            initials: String(client.initials || 'XX'),
            subscription: client.subscription ? {
              id: String(client.subscription.id || Date.now().toString()),
              clientId: String(client.id || ''),
              totalLessons: Number(client.subscription.totalLessons || 0),
              remainingLessons: Number(client.subscription.remainingLessons || 0),
              paid: Boolean(client.subscription.paid || false),
              purchasedAt: String(client.subscription.purchasedAt || new Date().toISOString()),
            } : null,
          }
        });
        console.log('Formatted clients:', formattedClients)
        
        self.clients = formattedClients as any
      } catch (error: any) {
        console.error('Error fetching clients:', error)
        self.error = error.message || 'Failed to load clients'
      } finally {
        self.isLoading = false
      }
    }),
    addClient: flow(function* (data: CreateClientDto) {
      // Optimistic update
      const tempId = `temp-${Date.now()}`
      const newClient = { ...data, id: tempId }
      self.clients.push(newClient as any)

      try {
        yield createClient(data)
        // После успешного добавления в Google Sheet, перезагружаем список, чтобы получить актуальные данные
        yield (self as any).loadClients()
      } catch (error: any) {
        // Rollback
        self.clients = self.clients.filter(c => c.id !== tempId) as any
        self.error = error.message || 'Failed to add client'
      }
    }),

  }))

export type IClientStore = Instance<typeof ClientStore>
