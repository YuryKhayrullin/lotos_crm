import { types, Instance } from 'mobx-state-tree'

export const LessonModel = types.model('Lesson', {
  id: types.identifier,
  branchId: types.string,
  dayOfWeek: types.optional(types.string, 'Пн'),
  date: types.maybe(types.string),
  time: types.union(types.string, types.number),
  title: types.string,
  category: types.optional(types.enumeration(['синхронное плавание', 'плавание']), 'плавание'),
  coachName: types.optional(types.string, ''),
  coachId: types.optional(types.string, ''),
  timeZone: types.optional(types.string, ''),
  startsAt: types.optional(types.string, ''),
  endsAt: types.optional(types.string, ''),
  version: types.optional(types.number, 0),
  status: types.optional(types.string, 'scheduled'),
  canEdit: types.optional(types.boolean, false),
  canCancel: types.optional(types.boolean, false),
  canDelete: types.optional(types.boolean, false),
  pool: types.optional(types.string, ''),
  duration: types.optional(types.string, '1 час'),
  maxCapacity: types.optional(types.union(types.number, types.string), 10),
  count: types.optional(types.string, '0 / 10'),
  isRecurring: types.optional(types.boolean, false),
})

export type ILesson = Instance<typeof LessonModel>
export type ILessonSnapshot = typeof LessonModel.Type
