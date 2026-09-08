import { types, Instance } from 'mobx-state-tree'

export const LessonModel = types.model('Lesson', {
  id: types.identifier,
  branchId: types.string,
  time: types.string, // HH:MM
  title: types.string,
  coachName: types.string,
  pool: types.string,
  count: types.string, // e.g. "8 / 10"
})

export type ILesson = Instance<typeof LessonModel>
export type ILessonSnapshot = typeof LessonModel.Type