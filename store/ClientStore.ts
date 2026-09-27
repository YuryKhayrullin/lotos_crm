import { types, flow, Instance } from 'mobx-state-tree'
import { ClientModel, IClient, CreateClientDto } from './models/Client'
import { apiClient, type ClientsPage } from '@/lib/api-client'
import { normalizeClient } from '@/lib/normalizers'

export const ClientStore = types
  .model('ClientStore', {
    clients: types.optional(types.array(ClientModel), []),
    isLoading: types.optional(types.boolean, false),
    error: types.maybeNull(types.string),
    page: types.optional(types.number, 1),
    total: types.optional(types.number, 0),
    hasMore: types.optional(types.boolean, false),
    requestVersion: types.optional(types.number, 0),
    branchScope: types.maybeNull(types.string),
    searchQuery: types.optional(types.string, ''),
    statusFilter: types.optional(types.string, ''),
  })
  .actions((self) => {
    let activeController: AbortController | null = null

    return {
      setBranchScope(branchId: string | null) {
        if (self.branchScope === branchId) return
        self.branchScope = branchId
        activeController?.abort()
        activeController = null
        self.requestVersion += 1
      },
      loadClients: flow(function* (initialPage?: ClientsPage) {
        activeController?.abort()
        const controller = new AbortController()
        activeController = controller
        self.isLoading = true
        self.error = null
        self.requestVersion += 1
        const requestVersion = self.requestVersion
        try {
          const page: ClientsPage =
            initialPage ??
            (yield apiClient.fetchClientsPage(
              1,
              100,
              controller.signal,
              self.branchScope || undefined,
              self.searchQuery || undefined,
              self.statusFilter || undefined,
            ))
          if (controller.signal.aborted || requestVersion !== self.requestVersion) return
          self.clients.replace(page.items as any)
          self.page = page.page
          self.total = page.total
          self.hasMore = page.hasMore
        } catch (error) {
          if (controller.signal.aborted) return
          self.error = error instanceof Error ? error.message : 'Не удалось загрузить клиентов'
          throw error
        } finally {
          if (requestVersion === self.requestVersion) self.isLoading = false
          if (activeController === controller) activeController = null
        }
      }),
      setFilters: flow(function* (query: string, status: string) {
        self.searchQuery = query.trim()
        self.statusFilter = status === 'all' ? '' : status
        yield (self as any).loadClients()
      }),
      loadNextPage: flow(function* (branchId?: string) {
        if (!self.hasMore || self.isLoading) return
        activeController?.abort()
        const controller = new AbortController()
        activeController = controller
        self.isLoading = true
        self.error = null
        self.requestVersion += 1
        const requestVersion = self.requestVersion
        try {
          const next = yield apiClient.fetchClientsPage(
            self.page + 1,
            100,
            controller.signal,
            branchId ?? self.branchScope ?? undefined,
            self.searchQuery || undefined,
            self.statusFilter || undefined,
          )
          if (controller.signal.aborted || requestVersion !== self.requestVersion) return
          self.clients.push(...next.items)
          self.page = next.page
          self.total = next.total
          self.hasMore = next.hasMore
        } catch (error: any) {
          if (controller.signal.aborted) return
          self.error = error.message || 'Failed to load more clients'
          throw error
        } finally {
          if (requestVersion === self.requestVersion) self.isLoading = false
          if (activeController === controller) activeController = null
        }
      }),
      addClient: flow(function* (data: CreateClientDto) {
        const newId = String(Date.now())
        const clientWithId = {
          ...data,
          id: newId,
          subscription: data.subscription
            ? {
                id: `${newId}-subscription`,
                clientId: newId,
                ...data.subscription,
              }
            : null,
        }

        try {
          const created = yield apiClient.createClient(clientWithId as CreateClientDto)
          const normalized = normalizeClient(created)
          const existingIndex = self.clients.findIndex((client) => client.id === normalized.id)
          if (existingIndex === -1) self.clients.push(normalized)
          self.total += 1
        } catch (error) {
          self.error = error instanceof Error ? error.message : 'Не удалось добавить клиента'
          throw error
        }
      }),

      // НОВАЯ ФУНКЦИЯ: Добавление подписки
      addSubscription: flow(function* (clientId: string, file: File, lessonsCount: number) {
        const client = self.clients.find((c) => c.id === clientId)
        if (!client) return

        try {
          self.isLoading = true
          const result = yield apiClient.uploadReceipt(clientId, file, lessonsCount)

          if (result.success) {
            // Перезагружаем данные для полной синхронизации с Google Sheets
            yield (self as any).loadClients()
          } else {
            self.error = result.message || 'Failed to add subscription'
          }
        } catch (err: any) {
          self.error = err.message || 'Failed to add subscription'
          throw err
        } finally {
          self.isLoading = false
        }
      }),

      // НОВАЯ ФУНКЦИЯ: Добавление занятий
      addLessons: flow(function* (clientId: string, count: number) {
        try {
          self.isLoading = true
          yield apiClient.addLessons(clientId, count)
          // Перезагружаем данные для полной синхронизации
          yield (self as any).loadClients()
        } catch (err: any) {
          self.error = err.message || 'Failed to add lessons'
          throw err
        } finally {
          self.isLoading = false
        }
      }),

      toggleClientLesson: flow(function* (clientId: string, lessonId: string) {
        const client = self.clients.find((c) => c.id === clientId)
        if (!client) {
          return
        }

        const oldLessons = [...client.assignedLessonIds]
        client.toggleAssignedLesson(lessonId)
        const newLessons = [...client.assignedLessonIds]

        try {
          const payload = {
            assignedLessonIds: newLessons.join(','),
            assignedLessonId: newLessons[0] || '',
          }
          const result = yield apiClient.updateClientAPI(clientId, payload)

          if (!result.success) throw new Error('Server rejected schedule update')
          yield (self as any).loadClients() // Перезагружаем данные для синхронизации
        } catch (err: any) {
          client.setAssignedLessons(oldLessons)
          self.error = err.message || 'Failed to update schedule'
          throw err
        }
      }),
      updateClientPayment: flow(function* (clientId: string, amount: number) {
        const client = self.clients.find((c) => c.id === clientId)
        if (!client) return

        const oldAmount = client.paidAmount
        client.paidAmount = amount // Optimistic update

        try {
          const result = yield apiClient.updateClientAPI(clientId, { paidAmount: amount })
          if (!result.success) throw new Error('Server rejected payment update')
        } catch (err: any) {
          client.paidAmount = oldAmount // Rollback
          self.error = err.message || 'Failed to update payment'
          throw err
        }
      }),
      markBulkAttendance: flow(function* (
        attendanceList: {
          clientId?: string
          visitorName?: string
          status: 'attended' | 'absent'
          isWalkin?: boolean
        }[],
        lessonId: string,
        date: string,
      ) {
        try {
          const result = yield apiClient.recordBulkAttendance(attendanceList, lessonId, date)
          const failed =
            Array.isArray(result.results) && result.results.some((item: { success: boolean }) => !item.success)
          if (!result.success || failed) throw new Error('Некоторые отметки посещаемости не сохранены')
          yield (self as any).loadClients()
        } catch (err: any) {
          self.error = err.message || 'Bulk attendance failed'
          throw err
        }
      }),

      // НОВАЯ ФУНКЦИЯ: Отметка посещения
      markAttendance: flow(function* (
        clientId: string,
        lessonId: string,
        status: 'attended' | 'absent',
        date?: string,
      ) {
        const client = self.clients.find((c) => c.id === clientId)
        if (!client) return

        try {
          const result = yield apiClient.recordAttendance(clientId, lessonId, status, date || new Date().toISOString())
          if (!result.success) throw new Error('Server rejected attendance')
          yield (self as any).loadClients()
        } catch (err: any) {
          self.error = err.message || 'Attendance failed'
          throw err
        }
      }),
    }
  })

export type IClientStore = Instance<typeof ClientStore>
