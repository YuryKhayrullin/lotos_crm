import { types, flow, Instance } from 'mobx-state-tree'
import { AuthModel } from './models/Auth'
import { apiClient } from '@/lib/api-client'

export const AuthStore = types
  .model('AuthStore', {
    user: types.maybeNull(AuthModel),
    isAuthenticated: types.optional(types.boolean, false),
    isLoading: types.optional(types.boolean, false),
    isInitialized: types.optional(types.boolean, false),
    sessionVersion: types.optional(types.number, 0),
    sessionError: types.maybeNull(types.string),
  })
  .actions((self) => {
    const expireSession = () => {
      apiClient.clearPrivateState()
      self.user = null
      self.isAuthenticated = false
      self.sessionError = null
      self.sessionVersion += 1
    }
    return {
      expireSession,
      init: flow(function* (force = false) {
        // React Strict Mode runs mount effects twice in development. Do not
        // start a second session probe while the first one is still pending.
        if (self.isLoading || (self.isInitialized && !force)) return
        self.isLoading = true
        self.isInitialized = false
        self.sessionError = null
        try {
          const response: Awaited<ReturnType<typeof apiClient.session>> = yield apiClient.session()
          if (!response.authenticated || !response.user) {
            expireSession()
            return
          }
          apiClient.clearPrivateState()
          self.user = {
            id: response.user.id,
            username: response.user.username,
            role: response.user.role,
            branchId: response.user.branchId === null ? null : String(response.user.branchId),
          }
          self.isAuthenticated = true
          self.sessionVersion += 1
        } catch {
          // A service outage is not evidence that the session is invalid. The
          // page shows a retry gate and does not expose a cached workspace.
          self.sessionError = 'Не удалось проверить доступ. Проверьте соединение и повторите попытку.'
        } finally {
          self.isInitialized = true
          self.isLoading = false
        }
      }),
      login: flow(function* (username: string, password: string) {
        if (self.isLoading) return
        self.isLoading = true
        try {
          const response: Awaited<ReturnType<typeof apiClient.login>> = yield apiClient.login(username, password)
          // Login already verifies the authoritative account and sets the
          // HttpOnly cookie. Do not perform a second remote session probe.
          apiClient.clearPrivateState()
          self.sessionError = null
          self.user = {
            id: response.user.id,
            username: response.user.username,
            role: response.user.role,
            branchId: response.user.branchId === null ? null : String(response.user.branchId),
          }
          self.isAuthenticated = true
          self.isInitialized = true
          self.sessionVersion += 1
        } catch (error) {
          throw error instanceof Error ? new Error(error.message) : new Error('Ошибка входа')
        } finally {
          self.isLoading = false
        }
      }),
      logout: flow(function* () {
        if (self.isLoading) return
        self.isLoading = true
        try {
          yield apiClient.logout()
          expireSession()
        } catch {
          self.sessionError = 'Не удалось завершить сессию. Повторите выход, когда соединение восстановится.'
        } finally {
          self.isInitialized = true
          self.isLoading = false
        }
      }),
    }
  })
  .views((self) => ({
    get isAdmin() {
      return self.user?.role === 'admin'
    },
    get isCoach() {
      return self.user?.role === 'coach'
    },
  }))

export type IAuthStore = Instance<typeof AuthStore>
