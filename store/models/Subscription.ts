import { types, Instance } from 'mobx-state-tree'

export const SubscriptionModel = types.model('Subscription', {
  id: types.identifier,
  clientId: types.string,
  totalLessons: types.number,
  remainingLessons: types.number,
  paid: types.boolean,
  purchasedAt: types.string, // ISO date string
})

export type ISubscription = Instance<typeof SubscriptionModel>
export type ISubscriptionSnapshot = typeof SubscriptionModel.Type