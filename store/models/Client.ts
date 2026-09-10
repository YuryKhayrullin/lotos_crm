import { types, Instance } from 'mobx-state-tree'
import { SubscriptionModel, ISubscription, ISubscriptionSnapshot } from './Subscription'

export const ClientModel = types
  .model('Client', {
    id: types.identifier,
    childName: types.string,
    parentName: types.string,
    phone: types.string,
    email: types.string,
    birthDate: types.string, // DD.MM.YYYY
    age: types.string, // e.g. "8 лет"
    branchId: types.string,
    status: types.enumeration(['Активен', 'Пауза', 'Архив']),
    initials: types.string,
    subscription: types.maybeNull(SubscriptionModel),
    assignedLessonId: types.maybeNull(types.string),
    assignedLessonIds: types.optional(types.array(types.string), []),
  })
  .views((self) => ({
    get isActive(): boolean {
      return self.status === 'Активен'
    },
    get hasSubscription(): boolean {
      return !!self.subscription
    },
    get remainingLessons(): number {
      return self.subscription?.remainingLessons ?? 0
    },
    get totalLessons(): number {
      return self.subscription?.totalLessons ?? 0
    },
    get subscriptionPaid(): boolean {
      return self.subscription?.paid ?? false
    },
    isAssignedTo(lessonId: string): boolean {
      return self.assignedLessonIds.includes(lessonId) || self.assignedLessonId === lessonId
    }
  }))
  .actions((self) => ({
    setAssignedLessons(lessonIds: string[]) {
      self.assignedLessonIds.replace(lessonIds)
      if (lessonIds.length > 0) {
        self.assignedLessonId = lessonIds[0]
      } else {
        self.assignedLessonId = null
      }
    },
    toggleAssignedLesson(lessonId: string) {
      if (self.assignedLessonIds.includes(lessonId)) {
        self.assignedLessonIds.remove(lessonId)
      } else {
        self.assignedLessonIds.push(lessonId)
      }
      if (self.assignedLessonIds.length > 0) {
        self.assignedLessonId = self.assignedLessonIds[0]
      } else {
        self.assignedLessonId = null
      }
    },
    updateSubscription(remaining: number, total: number, receiptUrl: string, status: 'Активен' | 'Пауза') {
      if (!self.subscription) {
        self.subscription = { 
          id: Date.now().toString(), 
          clientId: self.id, 
          totalLessons: total, 
          remainingLessons: remaining, 
          paid: true, 
          purchasedAt: new Date().toISOString(), 
          receiptUrl 
        } as any;
      } else {
        self.subscription.remainingLessons = remaining;
        self.subscription.totalLessons = total;
        self.subscription.paid = true;
        (self.subscription as any).receiptUrl = receiptUrl;
      }
      self.status = status;
    },
    consumeLesson(newRemaining: number, newStatus: 'Активен' | 'Пауза') {
      if (self.subscription) {
        self.subscription.remainingLessons = newRemaining;
      }
      self.status = newStatus;
    }
  }))


export type IClient = Instance<typeof ClientModel>
export type IClientSnapshot = typeof ClientModel.Type

export type CreateClientDto = {
  childName: string
  parentName: string
  phone: string
  email: string
  birthDate: string
  age: string
  branchId: string
  status: 'Активен' | 'Пауза' | 'Архив'
  initials: string
  subscription?: Omit<ISubscriptionSnapshot, 'id' | 'clientId'>
  assignedLessonId?: string | null
  assignedLessonIds?: string[]
}