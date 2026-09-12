import { types, Instance } from 'mobx-state-tree'

export const SubscriptionModel = types.model('Subscription', {
  id: types.identifier,
  clientId: types.string,
  totalLessons: types.union(types.number, types.string), 
  remainingLessons: types.union(types.number, types.string),
  paid: types.union(types.boolean, types.string), 
  purchasedAt: types.string,
  receiptUrl: types.maybe(types.string),
  status: types.optional(types.string, 'Активен'),
})
.views(self => ({
  get total() { return Number(self.totalLessons) },
  get remaining() { return Number(self.remainingLessons) }
}))
.actions(self => ({
  update(remainingLessons: number, receiptUrl: string, status: string) {
    self.remainingLessons = remainingLessons;
    self.receiptUrl = receiptUrl;
    self.status = status;
  }
}))

export type ISubscription = Instance<typeof SubscriptionModel>
export type ISubscriptionSnapshot = typeof SubscriptionModel.Type