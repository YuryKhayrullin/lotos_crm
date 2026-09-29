import { types, flow, Instance } from 'mobx-state-tree'
import { AuthModel } from './models/Auth'
import { apiClient, ApiError } from '@/lib/api-client'

const authLog = (event: string, details: Record<string, unknown> = {}): void => {
  console.log('[lotos-auth] ' + event, details)
}
export const AuthStore = types
  .model('AuthStore', {
    user: types.maybeNull(AuthModel),
    isAuthenticated: types.optional(types.boolean, false),
    isLoading: types.optional(types.boolean, false),
    isInitialized: types.optional(types.boolean, false),
    sessionVersion: types.optional(types.number, 0),
    registrationSuccess: types.optional(types.boolean, false),
  })
  .actions((self) => ({
    init: flow(function* () {
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
    setRegistrationSuccess(value: boolean) {
      self.registrationSuccess = value
    },
    register: flow(function* (username: string, password: string) {
      self.isLoading = true
      self.registrationSuccess = false
      try {
        const response: Awaited<ReturnType<typeof apiClient.register>> = yield apiClient.register({
          username,
          password,
        })
        if (response.status !== 'success') throw new Error('Ошибка регистрации')
        self.registrationSuccess = true
      } catch (error) {
        authLog('register.failed', { message: error instanceof Error ? error.message : 'unknown' })
        throw error instanceof ApiError ? new Error(error.message) : new Error('Ошибка регистрации')
      } finally {
        self.isLoading = false
      }
    }),
    login: flow(function* (username: string, password: string) {
      self.isLoading = true
      try {
        const response: Awaited<ReturnType<typeof apiClient.login>> = yield apiClient.login(username, password)
        authLog('login.password.accepted')
        const verifiedSession: Awaited<ReturnType<typeof apiClient.session>> = yield apiClient.session()
        if (!verifiedSession.authenticated || !verifiedSession.user) {
          authLog('login.session.rejected', { authenticated: verifiedSession.authenticated })
          throw new Error('Сессия не подтверждена сервером. Проверьте GAS deployment и пользователя.')
        }
        authLog('login.session.verified', { role: verifiedSession.user.role })
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
        authLog('login.failed', { message: error instanceof Error ? error.message : 'unknown' })
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
