import { types, Instance } from 'mobx-state-tree'

export const CoachModel = types.model('Coach', {
  id: types.identifier,
  name: types.string,
  specialty: types.string,
  initials: types.string,
  branchId: types.string,
})

export type ICoach = Instance<typeof CoachModel>
export type ICoachSnapshot = typeof CoachModel.Type