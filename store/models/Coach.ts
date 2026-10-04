import { types, Instance } from 'mobx-state-tree'

export const CoachModel = types.model('Coach', {
  id: types.identifier, // Используем identifier для MST
  name: types.optional(types.string, ''),
  specialty: types.optional(types.string, ''),
  initials: types.optional(types.string, ''),
  branchId: types.optional(types.union(types.string, types.number), ''),
  userId: types.optional(types.string, ''),
  phone: types.optional(types.string, ''),
  birthDate: types.optional(types.string, ''),
})

export type ICoach = Instance<typeof CoachModel>
export type ICoachSnapshot = typeof CoachModel.Type
