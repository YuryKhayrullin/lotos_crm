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
  ISubscription,
} from '@/store/models'

const SCREENS = [
  'Дашборд',
  'Клиенты и дети',
  'Тренеры',
  'Расписание',
  'Абонементы',
  'Финансы',
] as const

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
  .views((self) => {
    const s = self as any
    return {
      get currentBranch(): IBranch | undefined {
        return s.branches.find((b: any) => b.id === s.selectedBranchId)
      },
      get branchClients(): IClient[] {
        return s.clientStore.clients.filter((c: any) => c.branchId === s.selectedBranchId)
      },
      get branchCoaches(): ICoach[] {
        return s.coaches.filter((c: any) => c.branchId === s.selectedBranchId)
      },
      get branchLessons(): ILesson[] {
        return s.lessons.filter((l: any) => l.branchId === s.selectedBranchId)
      },
      get sortedBranchLessons(): ILesson[] {
        return [...s.branchLessons].sort((a: any, b: any) => a.time.localeCompare(b.time))
      },
      get dummy(): boolean { return true },
    }
  })
  .actions((self) => {
    const s = self as any
    return {
      setScreen(screen: string) {
        if (SCREENS.includes(screen as any)) {
          s.currentScreen = screen as any
          s.sidebarOpen = false
        }
      },
      setBranch(branchId: string) {
        s.selectedBranchId = branchId
        s.branchMenuOpen = false
      },
      toggleSidebar() {
        s.sidebarOpen = !s.sidebarOpen
      },
      closeSidebar() {
        s.sidebarOpen = false
      },
      toggleBranchMenu() {
        s.branchMenuOpen = !s.branchMenuOpen
        if (s.branchMenuOpen) {
          s.error = null
        }
      },
      closeBranchMenu() {
        s.branchMenuOpen = false
      },
      openClientForm() {
        s.clientFormData = {
          childName: '',
          parentName: '',
          phone: '',
          email: '',
          birthDate: '',
        }
        s.clientFormOpen = true
      },
      closeClientForm() {
        s.clientFormOpen = false
        s.clientFormData = {}
      },
      setClientFormField<K extends keyof CreateClientDto>(field: K, value: string) {
        s.clientFormData = { ...s.clientFormData, [field]: value }
      },
      selectClient(client: IClient) {
        s.selectedClient = client
      },
      closeClientModal() {
        s.selectedClient = null
      },
      startEditClient(client: IClient) {
        s.editingClient = client
        s.clientFormData = {
          childName: client.childName,
          parentName: client.parentName,
          phone: client.phone,
          email: client.email,
          birthDate: client.birthDate,
        }
        s.clientFormOpen = true
      },
      cancelEditClient() {
        s.editingClient = null
        s.closeClientForm()
      },
      openAttendance() {
        s.attendanceOpen = true
      },
      closeAttendance() {
        s.attendanceOpen = false
      },
      openLogin() {
        s.loginOpen = true
      },
      closeLogin() {
        s.loginOpen = false
      },
      selectCoach(coach: ICoach) {
        s.selectedCoach = coach
      },
      closeCoachModal() {
        s.selectedCoach = null
      },
      startEditCoach(coach: ICoach) {
        s.editingCoach = coach
        s.coachFormName = coach.name
        s.coachFormSpecialty = coach.specialty
      },
      cancelEditCoach() {
        s.editingCoach = null
        s.coachFormName = ''
        s.coachFormSpecialty = ''
      },
      setCoachFormName(value: string) {
        s.coachFormName = value
      },
      setCoachFormSpecialty(value: string) {
        s.coachFormSpecialty = value
      },
      setAttachCoachId(value: string) {
        s.attachCoachId = value
      },
      addBranch: flow(function* (name: string, address: string) {
        try {
          const response = yield apiClient.createBranch({ name, address })
          
          // If response is the branch object, use it. Otherwise, assume a successful message and create a local branch object.
          let newBranch = response
          if (!newBranch.id) {
             newBranch = {
               id: Date.now().toString(),
               name,
               address,
             }
          }
          
          s.branches.push(newBranch)
          s.setBranch(newBranch.id)
          s.branchMenuOpen = false
        } catch (error) {
          console.error('Failed to create branch:', error)
          s.error = 'Ошибка создания филиала'
        }
      }),
      setError(message: string | null) {
        s.error = message
      },
      initialize: flow(function* () {
        s.isLoading = true
        s.error = null
        try {
          console.log('Fetching data...')
          const [branches, coaches, lessons] = yield Promise.all([
            apiClient.fetchBranches(),
            apiClient.fetchCoaches(),
            apiClient.fetchLessons(),
          ])
          
          console.log('Data fetched:', { branches, coaches, lessons })
          
          yield s.clientStore.loadClients()
          
          s.branches.replace(branches)
          s.coaches.replace(coaches)
          s.lessons.replace(lessons)
          
          if (branches.length > 0 && !s.selectedBranchId) {
            s.selectedBranchId = branches[0].id
          }
        } catch (error) {
          console.error('Failed to load data:', error)
          s.error = 'Failed to load data'
        } finally {
          s.isLoading = false
        }
      }),
      createClient: flow(function* () {
        const data = s.clientFormData
        if (!data.childName || !data.parentName || !data.phone || !data.email || !data.birthDate) {
          s.error = 'Заполните все поля'
          return
        }
        try {
          s.error = null
          const branch = s.currentBranch
          if (!branch) throw new Error('Филиал не выбран')
          const [day, month, year] = data.birthDate.split('.').map(Number)
          const today = new Date()
          let age = today.getFullYear() - year
          if (today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day)) age--
          const initials = data.childName.split(' ').map((x: any) => x[0]).join('').slice(0, 2).toUpperCase()
          const clientData: CreateClientDto = {
            childName: data.childName!,
            parentName: data.parentName!,
            phone: data.phone!,
            email: data.email!,
            birthDate: data.birthDate!,
            age: `${age} лет`,
            branchId: branch.id,
            status: 'Активен',
            initials,
          }
          yield s.clientStore.addClient(clientData)
          s.closeClientForm()
        } catch (error: any) {
          s.error = error.message || 'Ошибка создания клиента'
        }
      }),
      updateClient: flow(function* () {
        if (!s.editingClient) return
        const data = s.clientFormData
        if (!data.childName || !data.parentName || !data.phone || !data.email || !data.birthDate) {
          s.error = 'Заполните все поля'
          return
        }
        try {
          s.error = null
          const [day, month, year] = data.birthDate.split('.').map(Number)
          const today = new Date()
          let age = today.getFullYear() - year
          if (today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day)) age--
          const initials = data.childName.split(' ').map((x: any) => x[0]).join('').slice(0, 2).toUpperCase()
          const updated = yield apiClient.updateClient(s.editingClient.id, {
            childName: data.childName,
            parentName: data.parentName,
            phone: data.phone,
            email: data.email,
            birthDate: data.birthDate,
            age: `${age} лет`,
            initials,
          })
          Object.assign(s.editingClient, updated)
          s.cancelEditClient()
        } catch (error) {
          s.error = error instanceof ApiError ? error.message : 'Ошибка обновления клиента'
        }
      }),
      toggleClientPaid: flow(function* (clientId: string) {
        const client = s.clients.find((c: any) => c.id === clientId)
        if (!client || !client.subscription) return
        try {
          const updated = yield apiClient.updateClient(clientId, {
            subscription: { ...client.subscription, paid: !client.subscription.paid } as ISubscription,
          })
          if (client.subscription) {
            client.subscription.paid = updated.subscription?.paid ?? !client.subscription.paid
          }
        } catch (error) {
          s.error = error instanceof ApiError ? error.message : 'Ошибка обновления оплаты'
        }
      }),
      deleteClient: flow(function* (clientId: string) {
        try {
          yield apiClient.deleteClient(clientId)
          const client = s.clients.find((c: any) => c.id === clientId)
          if (client) s.clients.remove(client)
          s.closeClientModal()
        } catch (error) {
          s.error = error instanceof ApiError ? error.message : 'Ошибка удаления клиента'
        }
      }),
      createCoach: flow(function* () {
        if (!s.coachFormName.trim() || !s.coachFormSpecialty.trim()) {
          s.error = 'Заполните все поля'
          return
        }
        const branch = s.currentBranch
        if (!branch) throw new Error('Филиал не выбран')
        try {
          s.error = null
          const initials = s.coachFormName.split(' ').map((x: any) => x[0]).join('').slice(0, 2).toUpperCase()
          const coach = yield apiClient.createCoach({
            name: s.coachFormName.trim(),
            specialty: s.coachFormSpecialty.trim(),
            initials,
            branchId: branch.id,
          })
          s.coaches.push(coach)
          s.coachFormName = ''
          s.coachFormSpecialty = ''
        } catch (error) {
          s.error = error instanceof ApiError ? error.message : 'Ошибка создания тренера'
        }
      }),
      updateCoach: flow(function* () {
        if (!s.editingCoach) return
        if (!s.coachFormName.trim() || !s.coachFormSpecialty.trim()) {
          s.error = 'Заполните все поля'
          return
        }
        try {
          s.error = null
          const initials = s.coachFormName.split(' ').map((x: any) => x[0]).join('').slice(0, 2).toUpperCase()
          const updated = yield apiClient.updateCoach(s.editingCoach.id, {
            name: s.coachFormName.trim(),
            specialty: s.coachFormSpecialty.trim(),
            initials,
          })
          Object.assign(s.editingCoach, updated)
          s.cancelEditCoach()
        } catch (error) {
          s.error = error instanceof ApiError ? error.message : 'Ошибка обновления тренера'
        }
      }),
      deleteCoach: flow(function* (coachId: string) {
        try {
          yield apiClient.deleteCoach(coachId)
          const coach = s.coaches.find((c: any) => c.id === coachId)
          if (coach) s.coaches.remove(coach)
          s.closeCoachModal()
        } catch (error) {
          s.error = error instanceof ApiError ? error.message : 'Ошибка удаления тренера'
        }
      }),
      attachCoach: flow(function* () {
        if (!s.attachCoachId) return
        const branch = s.currentBranch
        if (!branch) return
        try {
          s.error = null
          const coach = s.coaches.find((c: any) => c.id === s.attachCoachId)
          if (!coach) throw new Error('Тренер не найден')
          const existing = s.coaches.find((c: any) => c.name === coach.name && c.branchId === branch.id)
          if (existing) {
            s.error = 'Тренер уже прикреплён к этому филиалу'
            return
          }
          const attached = yield apiClient.createCoach({
            name: coach.name,
            specialty: coach.specialty,
            initials: coach.initials,
            branchId: branch.id,
          })
          s.coaches.push(attached)
          s.attachCoachId = ''
        } catch (error) {
          s.error = error instanceof ApiError ? error.message : 'Ошибка прикрепления тренера'
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
  }
  return storeInstance
}
