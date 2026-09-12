import { types, Instance } from 'mobx-state-tree'

export const LessonModel = types.model('Lesson', {
  id: types.identifier,
  branchId: types.string,
  dayOfWeek: types.optional(types.string, 'Пн'),
  time: types.string,
  title: types.string,
  coachName: types.string,
  pool: types.optional(types.string, ''),
  duration: types.optional(types.string, '1 час'),
  maxCapacity: types.optional(types.union(types.number, types.string), 10),
  count: types.optional(types.string, '0 / 10'),
})

export type ILesson = Instance<typeof LessonModel>
export type ILessonSnapshot = typeof LessonModel.Type