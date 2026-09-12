import { types, Instance } from 'mobx-state-tree'

export const BranchModel = types.model('Branch', {
  id: types.union(types.string, types.number),
  name: types.optional(types.string, ''),
  address: types.optional(types.string, ''),
})

export type IBranch = Instance<typeof BranchModel>
export type IBranchSnapshot = typeof BranchModel.Type