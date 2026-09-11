import { types, Instance } from 'mobx-state-tree'

export const LessonModel = types.model('Lesson', {
  id: types.identifier,
  branchId: types.string,
  dayOfWeek: types.optional(types.string, 'Пн'), // 'Пн' | 'Вт' | 'Ср' | 'Чт' | 'Пт' | 'Сб' | 'Вс'
  time: types.string, // e.g. "09:00", "12:00", "16:30", "17:00 - 19:00"
  title: types.string,
  coachName: types.string,
  pool: types.string,
  duration: types.optional(types.string, '1 час'),
  maxCapacity: types.optional(types.number, 10),
  count: types.optional(types.string, '0 / 10'),
})

export type ILesson = Instance<typeof LessonModel>
export type ILessonSnapshot = typeof LessonModel.Type