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
  }))

export type IClient = Instance<typeof ClientModel>
export type IClientSnapshot = typeof ClientModel.Type

export type CreateClientDto = Omit<IClientSnapshot, 'id' | 'subscription'> & {
  subscription?: Omit<ISubscriptionSnapshot, 'id' | 'clientId'>
}