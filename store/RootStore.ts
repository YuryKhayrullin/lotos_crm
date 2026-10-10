import { flow, types, Instance, applySnapshot } from 'mobx-state-tree'
import { apiClient, ApiError, type CoachAccount } from '@/lib/api-client'
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
    coachAccounts: types.optional(types.array(types.frozen<CoachAccount>()), []),
    coachAccountsSessionVersion: types.optional(types.number, -1),
    clientStore: types.optional(ClientStore, {}),
    authStore: types.optional(AuthStore, {}),
    lessons: types.optional(types.array(LessonModel), []),
    attendanceOpen: types.optional(types.boolean, false),
    loginOpen: types.optional(types.boolean, false),
    attachCoachId: types.optional(types.string, ''),
    isLoading: types.optional(types.boolean, true),
    hasLoadedData: types.optional(types.boolean, false),
    requiresAccessRefresh: types.optional(types.boolean, false),
    error: types.maybeNull(types.string),
  })
  .views((self) => ({
    get hasLoadedCoachAccounts(): boolean {
      return self.authStore.isAdmin && self.coachAccountsSessionVersion === self.authStore.sessionVersion
    },
    get currentCoachAccounts(): CoachAccount[] {
      return self.authStore.isAdmin && self.coachAccountsSessionVersion === self.authStore.sessionVersion
        ? self.coachAccounts.slice()
        : []
    },
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
    let dataForUser: string | null = null
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
    const sessionIdentity = () => `${String(self.authStore.user?.id || '')}:${self.authStore.sessionVersion}`

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
      rememberCoachAccounts(accounts: CoachAccount[]) {
        if (!self.authStore.isAdmin) return
        if (
          !Array.isArray(accounts) ||
          accounts.some(
            (account) =>
              !account ||
              !account.id ||
              !account.username ||
              account.role !== 'coach' ||
              !['Активен', 'Отключен', 'Ожидает подтверждения'].includes(account.status),
          )
        )
          throw new Error('Invalid trainer accounts')
        self.coachAccounts.replace(accounts)
        self.coachAccountsSessionVersion = self.authStore.sessionVersion
      },
      initialize: flow(function* (force = false) {
        const userId = self.authStore.user?.id
          ? `${String(self.authStore.user.id)}:${self.authStore.sessionVersion}`
          : null
        if (!userId) return
        if (self.authStore.isCoach && initializingForUser === userId) return
        if (!force && ((initializedForUser === userId && self.branches.length > 0) || initializingForUser === userId))
          return
        if (dataForUser !== userId) {
          self.branches.clear()
          self.coaches.clear()
          self.coachAccounts.clear()
          self.coachAccountsSessionVersion = -1
          self.lessons.clear()
          self.selectedBranchId = null
          self.hasLoadedData = false
          dataForUser = userId
        }
        activeInitializeController?.abort()
        const controller = new AbortController()
        const sameSession = () => `${String(self.authStore.user?.id)}:${self.authStore.sessionVersion}` === userId
        activeInitializeController = controller
        initializingForUser = userId
        self.isLoading = true
        try {
          // Only shared reference data belongs in the global bootstrap. Client
          // pages, reports and option search have independent server queries.
          const branchId = self.authStore.isAdmin ? self.selectedBranchId || undefined : undefined
          // Screens fetch their own visible data. Speculative reads here
          // contend with bootstrap/attendance for GAS and can outlive a tab.
          const { branches, coaches, lessons, coachAccounts } = yield apiClient.fetchBootstrapData(
            controller.signal,
            branchId,
            !self.authStore.isCoach,
          )
          if (controller.signal.aborted || !sameSession()) return

          if (
            self.authStore.isCoach &&
            (!self.authStore.user?.branchId ||
              !branches.some((branch: IBranch) => String(branch.id) === String(self.authStore.user?.branchId)) ||
              lessons.some((lesson: ILesson) => String(lesson.branchId) !== String(self.authStore.user?.branchId)))
          ) {
            throw new ApiError(403, { message: 'Не удалось подтвердить ваш филиал. Повторите проверку доступа.' })
          }

          self.branches.replace(branches)
          if (self.authStore.isAdmin && coachAccounts !== undefined) {
            self.coachAccounts.replace(coachAccounts)
            self.coachAccountsSessionVersion = self.authStore.sessionVersion
          }
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
          self.hasLoadedData = true
          self.requiresAccessRefresh = false
          self.error = null
          self.isLoading = false
        } catch (error: any) {
          if (controller.signal.aborted || !sameSession() || error?.name === 'AbortError') return
          if (error instanceof ApiError && (error.status === 401 || error.code === 'UNAUTHORIZED')) {
            self.authStore.expireSession()
            self.error = null
            return
          }
          self.error = error instanceof ApiError ? error.message : 'Ошибка загрузки данных'
          if (error instanceof ApiError && error.status === 403) {
            self.hasLoadedData = false
            self.requiresAccessRefresh = true
          }
          self.isLoading = false
        } finally {
          if (activeInitializeController === controller) {
            self.isLoading = false
            activeInitializeController = null
            if (initializingForUser === userId) initializingForUser = null
          }
        }
      }),
      addBranch: flow(function* (name: string, address: string) {
        const identity = sessionIdentity()
        try {
          const response = yield apiClient.createBranch({ name, address })
          if (sessionIdentity() !== identity) return
          if (!self.branches.some((branch) => branch.id === response.id)) self.branches.push(response)
          setBranch(response.id)
          self.branchMenuOpen = false
        } catch (error) {
          if (sessionIdentity() === identity) self.error = 'Ошибка создания филиала'
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
        const identity = sessionIdentity()
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
          if (sessionIdentity() !== identity)
            throw new Error('Сессия изменилась; ответ предыдущего пользователя отброшен')
          if (!self.coaches.some((existing) => existing.id === coach.id)) self.coaches.push(coach)
          return coach
        } catch (error) {
          if (sessionIdentity() === identity)
            self.error = error instanceof ApiError ? error.message : 'Ошибка создания тренера'
          throw error
        }
      }),
      deleteCoach: flow(function* (coachId: string) {
        const identity = sessionIdentity()
        try {
          yield apiClient.deleteCoach(coachId)
          if (sessionIdentity() !== identity) return
          const coach = self.coaches.find((c: ICoach) => c.id === coachId)
          if (coach) self.coaches.remove(coach)
        } catch (error) {
          if (sessionIdentity() === identity)
            self.error = error instanceof ApiError ? error.message : 'Ошибка удаления тренера'
          throw error
        }
      }),
      deleteLesson: flow(function* (lessonId: string) {
        const identity = sessionIdentity()
        try {
          yield apiClient.deleteLesson(lessonId)
          if (sessionIdentity() !== identity) return
          const lesson = self.lessons.find((l: ILesson) => l.id === lessonId)
          if (lesson) self.lessons.remove(lesson)
        } catch (error) {
          if (sessionIdentity() === identity)
            self.error = error instanceof ApiError ? error.message : 'Ошибка удаления занятия'
        }
      }),
      attachCoach: flow(function* () {
        const identity = sessionIdentity()
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
          if (sessionIdentity() !== identity) return
          self.coaches.push(attached)
          self.attachCoachId = ''
        } catch (error) {
          if (sessionIdentity() === identity)
            self.error = error instanceof ApiError ? error.message : 'Ошибка прикрепления тренера'
        }
      }),
      createLesson: flow(function* (lessonData: any) {
        const identity = sessionIdentity()
        try {
          const response = yield apiClient.createLesson(lessonData)
          if (sessionIdentity() !== identity)
            throw new Error('Сессия изменилась; ответ предыдущего пользователя отброшен')
          // Нормализуем ответ от сервера, так как Code.gs возвращает объект с ключами из таблицы
          const newLesson = normalizeLesson(response)
          const existingLesson = self.lessons.find((lesson) => lesson.id === newLesson.id)
          if (existingLesson) return existingLesson
          self.lessons.push(newLesson)
          return newLesson
        } catch (error: any) {
          if (sessionIdentity() === identity)
            self.error = error instanceof ApiError ? error.message : 'Ошибка создания урока'
          throw error
        }
      }),
      rememberSchedule(rows: unknown[], from: string, to: string, branchId?: string) {
        // Replace only the freshly loaded scope. Keep other dates for dashboard
        // counters without reviving removed lessons inside the requested week.
        const outside = self.lessons.filter(
          (lesson) =>
            (branchId && lesson.branchId !== branchId) || !lesson.date || lesson.date < from || lesson.date > to,
        )
        applySnapshot(self.lessons, [...outside.map((lesson) => ({ ...lesson })), ...rows.map(normalizeLesson)])
      },
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
