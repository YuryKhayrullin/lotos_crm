import { types, flow, Instance } from 'mobx-state-tree'
import { AuthModel } from './models/Auth'
import { apiClient } from '@/lib/api-client'

export const AuthStore = types
  .model('AuthStore', {
    user: types.maybeNull(AuthModel),
    isAuthenticated: types.optional(types.boolean, false),
    isLoading: types.optional(types.boolean, false),
    token: types.maybeNull(types.string),
  })
  .actions(self => ({
    register: flow(function* (username, password) {
      self.isLoading = true
      try {
        const response = yield apiClient.register(username, password)
        if (response.status === 'success') {
           yield (self as any).login(username, password)
        } else {
           throw new Error(response.message || 'Ошибка регистрации')
        }
      } catch (e: any) {
        console.error('Register error:', e)
        throw new Error(e.message || 'Ошибка регистрации')
      } finally {
        self.isLoading = false
      }
    }),
    login: flow(function* (username, password) {
      self.isLoading = true
      try {
        console.log('Sending login request:', { username })
        const response = yield apiClient.login(username, password)
        console.log('Login response:', response)
        self.user = response.user
        self.token = response.token
        self.isAuthenticated = true
        localStorage.setItem('crm_token', response.token)
      } catch (e) {
        console.error('Login error:', e)
        throw new Error('Ошибка входа')
      } finally {
        self.isLoading = false
      }
    }),
    logout() {
      self.user = null
      self.isAuthenticated = false
      self.token = null
      localStorage.removeItem('crm_token')
    }
  }))

export type IAuthStore = Instance<typeof AuthStore>
