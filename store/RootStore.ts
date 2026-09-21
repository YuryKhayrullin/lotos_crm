import { flow, types, Instance } from 'mobx-state-tree'
import { apiClient, ApiError } from '@/lib/api-client'
import { ClientStore } from './ClientStore'
import { AuthStore } from './AuthStore'
import {
  BranchModel,
  IBranch,
  CoachModel,
  ICoach,
  ClientModel,
  IClient,
  LessonModel,
  ILesson,
  CreateClientDto,
} from '@/store/models'
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
    clientFormOpen: types.optional(types.boolean, false),
    attendanceOpen: types.optional(types.boolean, false),
    loginOpen: types.optional(types.boolean, false),
    selectedClient: types.maybeNull(types.reference(ClientModel)),
    selectedCoach: types.maybeNull(types.reference(CoachModel)),
    editingClient: types.maybeNull(ClientModel),
    editingCoach: types.maybeNull(CoachModel),
    clientFormData: types.optional(
      types.frozen<Partial<CreateClientDto>>({
        childName: '',
        parentName: '',
        phone: '',
        email: '',
        birthDate: '',
      }),
      {}
    ),
    coachFormName: types.optional(types.string, ''),
    coachFormSpecialty: types.optional(types.string, ''),
    attachCoachId: types.optional(types.string, ''),
    isLoading: types.optional(types.boolean, true),
    error: types.maybeNull(types.string),
  })
  .views((self) => ({
    get currentBranch(): IBranch | undefined {
      return self.branches.find((b: IBranch) => b.id === self.selectedBranchId)
    },
    get branchClients(): IClient[] {
      if (!self.selectedBranchId) return self.clientStore.clients.slice()
      return self.clientStore.clients.filter((c: IClient) => c.branchId === self.selectedBranchId)
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
      return [...self.branchLessons].sort((a: ILesson, b: ILesson) => 
        String(a.time).localeCompare(String(b.time))
      )
    },
  }))
  .actions((self) => {
    const closeClientForm = () => {
      self.clientFormOpen = false
      self.clientFormData = {}
    }
    const closeBranchMenu = () => {
      self.branchMenuOpen = false
    }
    const cancelEditClient = () => {
      self.editingClient = null
      closeClientForm()
    }
    const closeClientModal = () => {
      self.selectedClient = null
    }
    const cancelEditCoach = () => {
      self.editingCoach = null
      self.coachFormName = ''
      self.coachFormSpecialty = ''
    }
    const setScreen = (screen: string) => {
      if (SCREENS.includes(screen as any)) {
        self.currentScreen = screen as any
        self.sidebarOpen = false
      }
    }
    const setBranch = (branchId: string) => {
      self.selectedBranchId = branchId
      self.branchMenuOpen = false
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
    const openClientForm = () => {
      self.clientFormData = {
        childName: '',
        parentName: '',
        phone: '',
        email: '',
        birthDate: '',
      }
      self.clientFormOpen = true
    }
    const setClientFormField = <K extends keyof CreateClientDto>(field: K, value: string) => {
      self.clientFormData = { ...self.clientFormData, [field]: value }
    }
    const selectClient = (client: IClient) => {
      self.selectedClient = client
    }
    const startEditClient = (client: IClient) => {
      self.editingClient = client
      self.clientFormData = {
        childName: client.childName,
        parentName: client.parentName,
        phone: client.phone,
        email: client.email,
        birthDate: client.birthDate,
      }
      self.clientFormOpen = true
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
    const selectCoach = (coach: ICoach) => {
      self.selectedCoach = coach
    }
    const closeCoachModal = () => {
      self.selectedCoach = null
    }
    const startEditCoach = (coach: ICoach) => {
      self.editingCoach = coach
      self.coachFormName = coach.name
      self.coachFormSpecialty = coach.specialty
    }
    const setCoachFormName = (value: string) => {
      self.coachFormName = value
    }
    const setCoachFormSpecialty = (value: string) => {
      self.coachFormSpecialty = value
    }
    const setAttachCoachId = (value: string) => {
      self.attachCoachId = value
    }
    const setError = (message: string | null) => {
      self.error = message
    }
    const addLessonToStore = (lessonData: any) => {
      self.lessons.push(lessonData);
    }
    
    return {
      closeClientForm,
      closeBranchMenu,
      cancelEditClient,
      closeClientModal,
      cancelEditCoach,
      setScreen,
      setBranch,
      toggleSidebar,
      closeSidebar,
      toggleBranchMenu,
      openClientForm,
      setClientFormField,
      selectClient,
      startEditClient,
      openAttendance,
      closeAttendance,
      openLogin,
      closeLogin,
      selectCoach,
      closeCoachModal,
      startEditCoach,
      setCoachFormName,
      setCoachFormSpecialty,
      setAttachCoachId,
      setError,
      addLessonToStore,
      initialize: flow(function* () {
        self.isLoading = true
        try {
          const [branches, coaches, lessons] = yield Promise.all([
            apiClient.fetchBranches(),
            apiClient.fetchCoaches(),
            apiClient.fetchLessons(),
          ])
          console.log('DEBUG INITIALIZE - Fetched:', { 
            branchesCount: branches.length, 
            coachesCount: coaches.length, 
            lessonsCount: lessons.length 
          });

          yield self.clientStore.loadClients()
          
          self.branches.replace(branches)
          self.coaches.replace(coaches)
          self.lessons.replace(lessons)
          
          console.log('DEBUG INITIALIZE - Store state:', { 
            branches: self.branches.length, 
            coaches: self.coaches.length, 
            lessons: self.lessons.length,
            clients: self.clientStore.clients.length
          });
          
          if (!self.selectedBranchId && branches.length > 0) {
            setBranch(String(branches[0].id))
            console.log('DEBUG INITIALIZE - Auto-selected branch:', branches[0].id);
          }

          self.isLoading = false
        } catch (error: any) {
          console.error('DEBUG INITIALIZE - Error:', error);
          self.error = error instanceof ApiError ? error.message : 'Ошибка загрузки данных'
          self.isLoading = false
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
      addClient: flow(function* (clientData: CreateClientDto) {
        try {
          const newClient = yield apiClient.createClient(clientData)
          self.clientStore.clients.push(newClient)
          closeClientForm()
        } catch (error) {
          self.error = error instanceof ApiError ? error.message : 'Ошибка создания клиента'
        }
      }),
      updateClient: flow(function* () {
        if (!self.editingClient) return
        try {
          const { subscription, assignedLessonIds, ...dataToUpdate } = self.clientFormData
          const updated = yield apiClient.updateClient(self.editingClient.id, dataToUpdate as Partial<IClient>)
          Object.assign(self.editingClient, updated)
          cancelEditClient()
        } catch (error) {
          self.error = error instanceof ApiError ? error.message : 'Ошибка обновления клиента'
        }
      }),
      deleteClient: flow(function* (clientId: string) {
        try {
          yield apiClient.deleteClient(clientId)
          const client = self.clientStore.clients.find((c: IClient) => c.id === clientId)
          if (client) self.clientStore.clients.remove(client)
          closeClientModal()
        } catch (error) {
          self.error = error instanceof ApiError ? error.message : 'Ошибка удаления клиента'
        }
      }),
      createCoach: flow(function* () {
        if (!self.coachFormName.trim() || !self.coachFormSpecialty.trim()) return
        const branch = self.currentBranch
        if (!branch) return
        try {
          const coach = yield apiClient.createCoach({
            name: self.coachFormName.trim(),
            specialty: self.coachFormSpecialty.trim(),
            branchId: branch.id,
          })
          self.coaches.push(coach)
          self.coachFormName = ''
          self.coachFormSpecialty = ''
        } catch (error) {
          self.error = error instanceof ApiError ? error.message : 'Ошибка создания тренера'
        }
      }),
      updateCoach: flow(function* () {
        if (!self.editingCoach) return
        try {
          const updated = yield apiClient.updateCoach(self.editingCoach.id, {
            name: self.coachFormName.trim(),
            specialty: self.coachFormSpecialty.trim(),
          })
          Object.assign(self.editingCoach, updated)
          cancelEditCoach()
        } catch (error) {
          self.error = error instanceof ApiError ? error.message : 'Ошибка обновления тренера'
        }
      }),
      deleteCoach: flow(function* (coachId: string) {
        try {
          yield apiClient.deleteCoach(coachId)
          const coach = self.coaches.find((c: ICoach) => c.id === coachId)
          if (coach) self.coaches.remove(coach)
        } catch (error) {
          self.error = error instanceof ApiError ? error.message : 'Ошибка удаления тренера'
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
            branchId: branch.id,
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
      clientFormOpen: false,
      attendanceOpen: false,
      loginOpen: false,
      clientFormData: {},
      coachFormName: '',
      coachFormSpecialty: '',
      attachCoachId: '',
      isLoading: true,
      error: null,
    })
    storeInstance.authStore.init()
  }
  return storeInstance
}
