import { types, Instance } from 'mobx-state-tree'

export const AuthModel = types.model('Auth', {
  id: types.union(types.string, types.number),
  username: types.string,
  role: types.maybe(types.union(types.string, types.number)),
  branchId: types.maybeNull(types.union(types.string, types.number)),
})

export type IAuth = Instance<typeof AuthModel>
export type IAuthSnapshot = typeof AuthModel.Type

export type LoginCredentials = {
  username: string
  password: string
}