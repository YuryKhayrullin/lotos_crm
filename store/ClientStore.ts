import { types, flow, Instance } from 'mobx-state-tree'
import { ClientModel, IClient, CreateClientDto } from './models/Client'
import { fetchClients, createClient, apiClient } from '@/lib/api-client'

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
            branchId: String(client.branchId || ''),
            status: validStatuses.includes(client.status) ? client.status : 'Активен',
            initials: String(client.initials || 'XX'),
            subscription: client.subscription ? {
              id: String(client.subscription.id || Date.now().toString()),
              clientId: String(client.id || ''),
              totalLessons: Number(client.subscription.totalLessons || 0),
              remainingLessons: Number(client.subscription.remainingLessons || 0),
              paid: Boolean(client.subscription.paid || false),
              purchasedAt: String(client.subscription.purchasedAt || new Date().toISOString()),
              receiptUrl: String(client.subscription.receiptUrl || ''),
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
      const tempId = `temp-${Date.now()}`
      const newClient = { ...data, id: tempId }
      self.clients.push(newClient as any)

      try {
        yield createClient(data)
        yield (self as any).loadClients()
      } catch (error: any) {
        self.clients = self.clients.filter(c => c.id !== tempId) as any
        self.error = error.message || 'Failed to add client'
      }
    }),

    // НОВАЯ ФУНКЦИЯ: Добавление подписки
    addSubscription: flow(function* (clientId: string, file: File, lessonsCount: number) {
      const client = self.clients.find(c => c.id === clientId);
      if (!client) return;

      try {
        self.isLoading = true;
        const result = yield apiClient.uploadReceipt(clientId, file, lessonsCount);
        
        if (result.success) {
          client.updateSubscription(
            result.remainingLessons,
            lessonsCount,
            result.receiptUrl,
            result.status
          );
        } else {
          self.error = result.message || "Failed to add subscription";
        }
      } catch (err: any) {
        self.error = err.message || "Failed to add subscription";
      } finally {
        self.isLoading = false;
      }
    }),

    // НОВАЯ ФУНКЦИЯ: Отметка посещения
    markAttendance: flow(function* (clientId: string) {
      const client = self.clients.find(c => c.id === clientId);
      if (!client || client.remainingLessons <= 0) return;

      const snapshotBefore = { remaining: client.remainingLessons, status: client.status };
      
      // Optimistic Update
      client.consumeLesson(client.remainingLessons - 1, (client.remainingLessons - 1) <= 0 ? 'Пауза' : 'Активен');

      try {
        const result = yield apiClient.markAttendance(clientId);
        if (!result.success) throw new Error("Server rejected attendance");
      } catch (err: any) {
        // Rollback
        client.consumeLesson(snapshotBefore.remaining, snapshotBefore.status as any);
        self.error = err.message || "Attendance failed";
      }
    }),

  }))

export type IClientStore = Instance<typeof ClientStore>
