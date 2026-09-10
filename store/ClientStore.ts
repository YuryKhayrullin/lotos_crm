import { types, flow, Instance } from 'mobx-state-tree'
import { ClientModel, IClient, CreateClientDto } from './models/Client'
import { apiClient } from '@/lib/api-client'

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
        const rawData = yield apiClient.fetchClients()
        console.log('RAW API RESPONSE:', rawData)
        
        const clientsArray = Array.isArray(rawData) ? rawData : (rawData && typeof rawData === 'object' ? Object.values(rawData) : []);
        
        const validStatuses = ['Активен', 'Пауза', 'Архив'];
        const formattedClients = clientsArray.map(client => {
          console.log('Mapping client:', client)
          
          // Функция защиты от отображения ошибок из ячеек Google Sheets
          const cleanVal = (val: any, fallback: string = "") => {
            const s = String(val || "").trim();
            return (s === "#ERROR!" || s === "#VALUE!" || s.indexOf("#") === 0) ? fallback : s;
          };

          return {
            id: String(client.id || ''),
            childName: cleanVal(client.childName, 'Без имени'),
            parentName: cleanVal(client.parentName, 'Без имени'),
            phone: cleanVal(client.phone, 'Нет'),
            email: cleanVal(client.email, 'Нет'),
            birthDate: cleanVal(client.birthDate, '01.01.2000'),
            age: cleanVal(client.age, '0 лет'),
            branchId: String(client.branchId || ''),
            status: validStatuses.includes(client.status) ? client.status : 'Активен',
            initials: cleanVal(client.initials, 'XX'),
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
      const newId = String(Date.now());
      const clientWithId = { ...data, id: newId };
      
      // Добавляем временно в стейт для мгновенного UI-обновления
      self.clients.push(clientWithId as any);

      try {
        yield apiClient.createClient(clientWithId);
        // Перезагружаем список, чтобы получить актуальные данные с сервера (включая правильный branchId)
        yield (self as any).loadClients();
      } catch (error: any) {
        // Откат при ошибке
        self.clients = self.clients.filter(c => c.id !== newId) as any;
        self.error = error.message || 'Failed to add client';
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
            result.status // 'Активен' or 'Пауза'
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

    // НОВАЯ ФУНКЦИЯ: Добавление занятий
    addLessons: flow(function* (clientId: string, count: number) {
      const client = self.clients.find(c => c.id === clientId);
      if (!client || !client.subscription) return;

      const snapshotBefore = { remaining: client.remainingLessons, status: client.status };
      
      const newRemaining = client.remainingLessons + count;
      client.updateSubscription(newRemaining, client.totalLessons + count, client.subscription.receiptUrl || '', 'Активен');

      try {
        const result = yield apiClient.updateClientAPI(clientId, { 
          remainingLessons: newRemaining, 
          status: 'Активен' 
        });
        if (!result.success) throw new Error("Server rejected addLessons");
      } catch (err: any) {
        client.updateSubscription(snapshotBefore.remaining, client.totalLessons, client.subscription.receiptUrl || '', snapshotBefore.status as any);
        self.error = err.message || "Failed to add lessons";
      }
    }),

    // НОВАЯ ФУНКЦИЯ: Отметка посещения
    markAttendance: flow(function* (clientId: string) {
      const client = self.clients.find(c => c.id === clientId);
      if (!client || client.remainingLessons <= 0) return;

      const snapshotBefore = { remaining: client.remainingLessons, status: client.status };
      
      const newRemaining = client.remainingLessons - 1;
      const newStatus = newRemaining <= 0 ? 'Пауза' : 'Активен';
      
      // Optimistic Update
      client.consumeLesson(newRemaining, newStatus);

      try {
        const result = yield apiClient.updateClientAPI(clientId, { 
          remainingLessons: newRemaining, 
          status: newStatus 
        });
        if (!result.success) throw new Error("Server rejected attendance");
      } catch (err: any) {
        // Rollback
        client.consumeLesson(snapshotBefore.remaining, snapshotBefore.status as any);
        self.error = err.message || "Attendance failed";
      }
    }),

  }))

export type IClientStore = Instance<typeof ClientStore>
