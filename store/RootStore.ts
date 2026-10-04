import { flow, types, Instance } from 'mobx-state-tree'
import { apiClient, ApiError } from '@/lib/api-client'
import { ClientStore } from './ClientStore'
import { AuthStore } from './AuthStore'
import { BranchModel, IBranch, CoachModel, ICoach, LessonModel, ILesson } from '@/store/models'
import { normalizeLesson } from '@/lib/normalizers'

const SCREENS = ['Дашборд', 'Клиенты и дети', 'Тренеры', 'Расписание', 'Абонементы', 'Финансы'] as const

const RootStoreModel = types
  .model('RootStore', {
    currentScreen: types.optional(types.enumeration(SCREENS), 'Дашборд'),
    selectedBranchId: types.maybeNull(types.string),
    sidebarOpen: types.optional(types.boolean, false),
    branchMenuOpen: types.optional(types.boolean, false),
    branches: types.optional(types.array(BranchModel), []),
    coaches: types.optional(types.array(CoachModel), []),
    clientStore: types.optional(ClientStore, {}),
    authStore: types.optional(AuthStore, {}),
    lessons: types.optional(types.array(LessonModel), []),
    attendanceOpen: types.optional(types.boolean, false),
    loginOpen: types.optional(types.boolean, false),
    attachCoachId: types.optional(types.string, ''),
    isLoading: types.optional(types.boolean, true),
    error: types.maybeNull(types.string),
  })
  .views((self) => ({
    get currentBranch(): IBranch | undefined {
      return self.branches.find((b: IBranch) => b.id === self.selectedBranchId)
    },
    get branchCoaches(): ICoach[] {
      if (!self.selectedBranchId) return self.coaches.slice()
      return self.coaches.filter((c: ICoach) => c.branchId === self.selectedBranchId)
    },
    get branchLessons(): ILesson[] {
      if (!self.selectedBranchId) return self.lessons.slice()
      return self.lessons.filter((l: ILesson) => l.branchId === self.selectedBranchId)
    },
  }))
  .views((self) => ({
    get sortedBranchLessons(): ILesson[] {
      return [...self.branchLessons].sort((a: ILesson, b: ILesson) => String(a.time).localeCompare(String(b.time)))
    },
  }))
  .actions((self) => {
    let activeInitializeController: AbortController | null = null
    let initializedForUser: string | null = null
    let initializingForUser: string | null = null
    const closeBranchMenu = () => {
      self.branchMenuOpen = false
    }
    const setScreen = (screen: string) => {
      if (SCREENS.includes(screen as any)) {
        if (self.authStore.isCoach && screen !== 'Дашборд' && screen !== 'Расписание') return
        self.currentScreen = screen as any
        self.sidebarOpen = false
      }
    }
    const setBranch = (branchId: string) => {
      self.selectedBranchId = branchId
      self.branchMenuOpen = false
      initializedForUser = null
    }
    const toggleSidebar = () => {
      self.sidebarOpen = !self.sidebarOpen
    }
    const closeSidebar = () => {
      self.sidebarOpen = false
    }
    const toggleBranchMenu = () => {
      self.branchMenuOpen = !self.branchMenuOpen
      if (self.branchMenuOpen) self.error = null
    }
    const openAttendance = () => {
      self.attendanceOpen = true
    }
    const closeAttendance = () => {
      self.attendanceOpen = false
    }
    const openLogin = () => {
      self.loginOpen = true
    }
    const closeLogin = () => {
      self.loginOpen = false
    }
    const setAttachCoachId = (value: string) => {
      self.attachCoachId = value
    }
    const setError = (message: string | null) => {
      self.error = message
    }
    const cancelInitialize = () => {
      activeInitializeController?.abort()
      activeInitializeController = null
      initializedForUser = null
      initializingForUser = null
      self.isLoading = false
    }
    const addLessonToStore = (lessonData: any) => {
      self.lessons.push(lessonData)
    }

    return {
      closeBranchMenu,
      setScreen,
      setBranch,
      toggleSidebar,
      closeSidebar,
      toggleBranchMenu,
      openAttendance,
      closeAttendance,
      openLogin,
      closeLogin,
      cancelInitialize,
      setAttachCoachId,
      setError,
      addLessonToStore,
      initialize: flow(function* (force = false) {
        const userId = self.authStore.user?.id
          ? `${String(self.authStore.user.id)}:${self.authStore.sessionVersion}`
          : null
        if (!force && ((initializedForUser === userId && self.branches.length > 0) || initializingForUser === userId))
          return
        activeInitializeController?.abort()
        const controller = new AbortController()
        activeInitializeController = controller
        initializingForUser = userId
        self.isLoading = true
        try {
          // Only shared reference data belongs in the global bootstrap. Client
          // pages, reports and option search have independent server queries.
          const branchId = self.authStore.isAdmin ? self.selectedBranchId || undefined : undefined
          // Warm the first visible admin reads while the single bootstrap GAS
          // call is already in flight. The BFF coalesces an early click with
          // these requests and keeps the completed result private to this user.
          if (self.authStore.isAdmin) {
            void apiClient
              .fetchClientsPage(1, 100, controller.signal, branchId, undefined, undefined, 'childName', 'asc')
              .catch(() => undefined)
            void apiClient.getDashboardSummary(controller.signal, branchId).catch(() => undefined)
          }
          const { branches, coaches, lessons } = yield apiClient.fetchBootstrapData(controller.signal, branchId)
          if (controller.signal.aborted) return

          self.branches.replace(branches)
          self.coaches.replace(coaches)
          self.lessons.replace(lessons)

          if (!self.selectedBranchId && branches.length > 0 && self.authStore.isCoach) {
            const userBranchId = self.authStore.user?.branchId
            const requestedBranchId = userBranchId !== null && userBranchId !== undefined ? String(userBranchId) : null
            const branchId =
              requestedBranchId && branches.some((branch: IBranch) => String(branch.id) === requestedBranchId)
                ? requestedBranchId
                : String(branches[0].id)
            setBranch(branchId)
          }

          initializedForUser = userId
          self.isLoading = false
        } catch (error: any) {
          if (error?.name === 'AbortError') return
          if (error instanceof ApiError && (error.status === 401 || error.code === 'UNAUTHORIZED')) {
            yield self.authStore.logout()
            self.error = null
            return
          }
          self.error = error instanceof ApiError ? error.message : 'Ошибка загрузки данных'
          self.isLoading = false
        } finally {
          if (activeInitializeController === controller) {
            activeInitializeController = null
            if (initializingForUser === userId) initializingForUser = null
          }
        }
      }),
      addBranch: flow(function* (name: string, address: string) {
        try {
          const response = yield apiClient.createBranch({ name, address })
          self.branches.push(response)
          setBranch(response.id)
          self.branchMenuOpen = false
        } catch (error) {
          self.error = 'Ошибка создания филиала'
        }
      }),
      createCoach: flow(function* (coachData: {
        name: string
        specialty: string
        branchId: string
        phone?: string
        birthDate?: string
        username?: string
        password?: string
      }) {
        if (!coachData.name.trim() || !coachData.specialty.trim() || !coachData.branchId) {
          throw new Error('Укажите имя, специализацию и филиал тренера')
        }
        try {
          const coach = yield apiClient.createCoach({
            name: coachData.name.trim(),
            specialty: coachData.specialty.trim(),
            branchId: coachData.branchId,
            initials: coachData.name
              .trim()
              .split(/\s+/)
              .map((part) => part[0])
              .join('')
              .slice(0, 2)
              .toUpperCase(),
            phone: coachData.phone?.trim() || '',
            birthDate: coachData.birthDate?.trim() || '',
            ...(coachData.username ? { username: coachData.username.trim(), password: coachData.password } : {}),
          })
          self.coaches.push(coach)
          return coach
        } catch (error) {
          self.error = error instanceof ApiError ? error.message : 'Ошибка создания тренера'
          throw error
        }
      }),
      deleteCoach: flow(function* (coachId: string) {
        try {
          yield apiClient.deleteCoach(coachId)
          const coach = self.coaches.find((c: ICoach) => c.id === coachId)
          if (coach) self.coaches.remove(coach)
        } catch (error) {
          self.error = error instanceof ApiError ? error.message : 'Ошибка удаления тренера'
          throw error
        }
      }),
      deleteLesson: flow(function* (lessonId: string) {
        try {
          yield apiClient.deleteLesson(lessonId)
          const lesson = self.lessons.find((l: ILesson) => l.id === lessonId)
          if (lesson) self.lessons.remove(lesson)
        } catch (error) {
          self.error = error instanceof ApiError ? error.message : 'Ошибка удаления занятия'
        }
      }),
      attachCoach: flow(function* () {
        if (!self.attachCoachId) return
        const branch = self.currentBranch
        if (!branch) return
        try {
          const coach = self.coaches.find((c: ICoach) => c.id === self.attachCoachId)
          if (!coach) return
          const attached = yield apiClient.createCoach({
            name: coach.name,
            specialty: coach.specialty,
            initials: coach.initials,
            branchId: String(branch.id),
          })
          self.coaches.push(attached)
          self.attachCoachId = ''
        } catch (error) {
          self.error = error instanceof ApiError ? error.message : 'Ошибка прикрепления тренера'
        }
      }),
      createLesson: flow(function* (lessonData: any) {
        try {
          const response = yield apiClient.createLesson(lessonData)
          // Нормализуем ответ от сервера, так как Code.gs возвращает объект с ключами из таблицы
          const newLesson = normalizeLesson(response)
          self.lessons.push(newLesson)
          return newLesson
        } catch (error: any) {
          self.error = error instanceof ApiError ? error.message : 'Ошибка создания урока'
          throw error
        }
      }),
    }
  })

export const RootStore = RootStoreModel
export type IRootStore = Instance<typeof RootStoreModel>

let storeInstance: IRootStore | null = null

export function getStore(): IRootStore {
  if (!storeInstance) {
    storeInstance = RootStore.create({
      currentScreen: 'Дашборд',
      sidebarOpen: false,
      branchMenuOpen: false,
      branches: [],
      coaches: [],
      clientStore: {},
      authStore: {},
      lessons: [],
      attendanceOpen: false,
      loginOpen: false,
      attachCoachId: '',
      isLoading: true,
      error: null,
    })
  }
  return storeInstance
}
