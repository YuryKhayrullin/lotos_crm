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

          const rawAssigned = client.assignedLessonIds || client.assignedLessonId;
          const assignedLessonIds = rawAssigned 
            ? (Array.isArray(rawAssigned) ? rawAssigned.map(String) : String(rawAssigned).split(',').map(s => s.trim()).filter(Boolean))
            : [];

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
            paidAmount: Number(client.paidAmount || 0),
            assignedLessonId: assignedLessonIds[0] || null,
            assignedLessonIds: assignedLessonIds,
            subscription: client.subscription ? {
              id: String(client.subscription.id || Date.now().toString()),
              clientId: String(client.id || ''),
              totalLessons: Number(client.subscription.totalLessons || 0),
              remainingLessons: Number(client.subscription.remainingLessons || 0),
              paid: Boolean(client.subscription.paid || false),
              purchasedAt: (client.subscription.purchasedAt && !String(client.subscription.purchasedAt).includes('1899-12-30')) ? String(client.subscription.purchasedAt) : new Date().toISOString(),
              receiptUrl: String(client.subscription.receiptUrl || ''),
            } : (client.remainingLessons !== undefined && client.remainingLessons !== "" ? {
              id: Date.now().toString(),
              clientId: String(client.id || ''),
              totalLessons: Number(client.totalLessons || client.remainingLessons || 0),
              remainingLessons: Number(client.remainingLessons || 0),
              paid: true,
              purchasedAt: new Date().toISOString(),
              receiptUrl: '',
            } : null),
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
          // Перезагружаем данные для полной синхронизации с Google Sheets
          yield (self as any).loadClients();
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
      try {
        self.isLoading = true;
        // Используем uploadReceipt или updateClientAPI в зависимости от вашей логики в Code.gs
        // Если вы обновляете через uploadReceipt (без файла) или другой метод:
        yield apiClient.updateClientAPI(clientId, { lessonsCount: count });
        // Перезагружаем данные для полной синхронизации
        yield (self as any).loadClients();
      } catch (err: any) {
        self.error = err.message || "Failed to add lessons";
      } finally {
        self.isLoading = false;
      }
    }),

    toggleClientLesson: flow(function* (clientId: string, lessonId: string) {
      const client = self.clients.find(c => c.id === clientId);
      if (!client) return;

      const oldLessons = [...client.assignedLessonIds];
      client.toggleAssignedLesson(lessonId);
      const newLessons = [...client.assignedLessonIds];

      try {
        const result = yield apiClient.updateClientAPI(clientId, {
          assignedLessonIds: newLessons.join(','),
          assignedLessonId: newLessons[0] || ''
        });
        if (!result.success) throw new Error("Server rejected schedule update");
        yield (self as any).loadClients(); // Перезагружаем данные для синхронизации
      } catch (err: any) {
        client.setAssignedLessons(oldLessons);
        self.error = err.message || "Failed to update schedule";
        throw err;
      }
    }),
    updateClientPayment: flow(function* (clientId: string, amount: number) {
      const client = self.clients.find(c => c.id === clientId);
      if (!client) return;

      const oldAmount = client.paidAmount;
      client.paidAmount = amount; // Optimistic update

      try {
        const result = yield apiClient.updateClientAPI(clientId, { paidAmount: amount });
        if (!result.success) throw new Error("Server rejected payment update");
      } catch (err: any) {
        client.paidAmount = oldAmount; // Rollback
        self.error = err.message || "Failed to update payment";
        throw err;
      }
    }),
markBulkAttendance: flow(function* (attendanceList: { clientId: string, status: 'attended' | 'absent' }[], lessonId: string, date: string) {
  const snapshots = new Map();
  attendanceList.forEach(({ clientId, status }) => {
    const client = self.clients.find(c => c.id === clientId);
    if (client) {
      snapshots.set(clientId, { remaining: client.remainingLessons, status: client.status });
      if (status === 'attended') {
        const newRem = Math.max(0, client.remainingLessons - 1);
        const newStat = newRem <= 0 ? 'Пауза' : 'Активен';
        client.consumeLesson(newRem, newStat);
      }
    }
  });

  try {
    const result = yield apiClient.recordBulkAttendance(attendanceList, lessonId, new Date().toLocaleDateString());
    if (!result.success) throw new Error("Server rejected bulk attendance");
  } catch (err: any) {
    // Откат
    snapshots.forEach((snap, clientId) => {
        const client = self.clients.find(c => c.id === clientId);
        if (client) client.consumeLesson(snap.remaining, snap.status);
    });
    self.error = err.message || "Bulk attendance failed";
  }
}),
    
    // НОВАЯ ФУНКЦИЯ: Отметка посещения
    markAttendance: flow(function* (clientId: string, lessonId: string, status: 'attended' | 'absent') {
      const client = self.clients.find(c => c.id === clientId);
      if (!client) return;

      const snapshotBefore = { remaining: client.remainingLessons, status: client.status };
      
      // Только списываем занятие, если клиент пришел и у него есть уроки
      const newRemaining = (status === 'attended' && client.remainingLessons > 0) ? client.remainingLessons - 1 : client.remainingLessons;
      const newStatus = (status === 'attended' && newRemaining <= 0) ? 'Пауза' : client.status;
      
      // Optimistic Update
      if (status === 'attended') {
          client.consumeLesson(newRemaining, newStatus as any);
      }

      try {
        const result = yield apiClient.recordAttendance(clientId, lessonId, status, new Date().toLocaleDateString());
        if (!result.success) throw new Error("Server rejected attendance");
      } catch (err: any) {
        // Rollback
        if (status === 'attended') {
            client.consumeLesson(snapshotBefore.remaining, snapshotBefore.status as any);
        }
        self.error = err.message || "Attendance failed";
      }
    }),

  }))

export type IClientStore = Instance<typeof ClientStore>

