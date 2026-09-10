import { types, Instance } from 'mobx-state-tree'

export const SubscriptionModel = types.model('Subscription', {
  id: types.identifier,
  clientId: types.string,
  totalLessons: types.number,
  remainingLessons: types.number,
  paid: types.boolean,
  purchasedAt: types.string, // ISO date string
  receiptUrl: types.maybe(types.string),
  status: types.optional(types.string, 'Активен'),
})
.actions(self => ({
  update(remainingLessons: number, receiptUrl: string, status: string) {
    self.remainingLessons = remainingLessons;
    self.receiptUrl = receiptUrl;
    self.status = status;
  }
}))

export type ISubscription = Instance<typeof SubscriptionModel>
export type ISubscriptionSnapshot = typeof SubscriptionModel.Type