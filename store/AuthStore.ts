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
  })
  .actions((self) => ({
    init: flow(function* () {
      // React Strict Mode runs mount effects twice in development. Do not
      // start a second session probe while the first one is still pending.
      if (self.isLoading || self.isInitialized) return
      self.isLoading = true
      try {
        const response: Awaited<ReturnType<typeof apiClient.session>> = yield apiClient.session()
        if (!response.authenticated || !response.user) {
          self.user = null
          self.isAuthenticated = false
          return
        }
        self.user = {
          id: response.user.id,
          username: response.user.username,
          role: response.user.role,
          branchId: response.user.branchId === null ? null : String(response.user.branchId),
        }
        self.isAuthenticated = true
        self.sessionVersion += 1
      } catch {
        self.user = null
        self.isAuthenticated = false
      } finally {
        self.isInitialized = true
        self.isLoading = false
      }
    }),
    login: flow(function* (username: string, password: string) {
      self.isLoading = true
      try {
        const response: Awaited<ReturnType<typeof apiClient.login>> = yield apiClient.login(username, password)
        const verifiedSession: Awaited<ReturnType<typeof apiClient.session>> = yield apiClient.session()
        if (!verifiedSession.authenticated || !verifiedSession.user) {
          throw new Error('Не удалось подтвердить сессию. Повторите вход.')
        }
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
      self.isLoading = true
      try {
        yield apiClient.logout()
      } finally {
        self.user = null
        self.isAuthenticated = false
        self.sessionVersion += 1
        self.isInitialized = true
        self.isLoading = false
      }
    }),
  }))
  .views((self) => ({
    get isAdmin() {
      return self.user?.role === 'admin'
    },
    get isCoach() {
      return self.user?.role === 'coach'
    },
  }))

export type IAuthStore = Instance<typeof AuthStore>
