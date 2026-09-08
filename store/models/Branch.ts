import { types, Instance } from 'mobx-state-tree'

export const BranchModel = types.model('Branch', {
  id: types.identifier,
  name: types.string,
  address: types.string,
})

export type IBranch = Instance<typeof BranchModel>
export type IBranchSnapshot = typeof BranchModel.Type