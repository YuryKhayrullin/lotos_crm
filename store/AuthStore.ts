import { types, flow, Instance } from 'mobx-state-tree'
import { AuthModel } from './models/Auth'
import { apiClient } from '@/lib/api-client'

export const AuthStore = types
  .model('AuthStore', {
    user: types.maybeNull(AuthModel),
    isAuthenticated: types.optional(types.boolean, false),
    isLoading: types.optional(types.boolean, false),
    registrationSuccess: types.optional(types.boolean, false),
    token: types.maybeNull(types.string),
  })
  .actions(self => ({
    init() {
      if (typeof window !== 'undefined') {
        const token = localStorage.getItem('crm_token');
        const user = localStorage.getItem('crm_user');
        if (token && user) {
          self.token = token;
          self.isAuthenticated = true;
          self.user = JSON.parse(user);
        }
      }
    },
    setRegistrationSuccess(value: boolean) {
      self.registrationSuccess = value
    },
    register: flow(function* (username: string, password: string, branchId: string) {
      self.isLoading = true
      self.registrationSuccess = false
      try {
        const response = yield apiClient.register({ username, password, branchId })
        if (response.status === 'success') {
           self.registrationSuccess = true
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
    login: flow(function* (username: string, password: string) {
      self.isLoading = true
      try {
        const response = yield apiClient.login(username, password)
        // Нормализация роли: 1 -> admin, 2 -> coach
        const normalizedRole = String(response.user.role) === '1' ? 'admin' : 'coach';

        const user = {
            ...response.user,
            role: normalizedRole,
            branchId: response.user.branchId || String(response.user.branchId) || null
        };
        self.user = user
        self.token = response.token
        self.isAuthenticated = true
        localStorage.setItem('crm_token', response.token)
        localStorage.setItem('crm_user', JSON.stringify(user))
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
      localStorage.removeItem('crm_user')
    }
    }))
    .views(self => ({
    get isAdmin() {
      return self.user?.role === 'admin'
    },
    get isCoach() {
      return self.user?.role === 'coach'
    }
    }))

export type IAuthStore = Instance<typeof AuthStore>
