const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isLessonInWeek,
  isLessonOnDay,
  lessonOccurrenceDate,
  parseTimeToHHMM,
} = require('../.test-dist/utils/date-core.js')

const lesson = (date, dayOfWeek, isRecurring = false) => ({ date, dayOfWeek, isRecurring })
const weekStart = new Date('2026-09-21T00:00:00')
const weekEnd = new Date('2026-09-27T00:00:00')

test('filters dated lessons by week', () => {
  assert.equal(isLessonInWeek(lesson('2026-09-22', 'Вт'), weekStart, weekEnd), true)
  assert.equal(isLessonInWeek(lesson('2026-09-28', 'Пн'), weekStart, weekEnd), false)
})

test('filters recurring lessons by weekday and excludes non-recurring lessons without date', () => {
  assert.equal(isLessonInWeek(lesson(null, 'Пн'), weekStart, weekEnd), false)
  assert.equal(isLessonOnDay(lesson(null, 'Пн', true), new Date('2026-09-21T10:00:00')), true)
  assert.equal(isLessonOnDay(lesson(null, 'Пн', true), new Date('2026-09-22T10:00:00')), false)
})

test('normalizes supported time formats', () => {
  assert.equal(parseTimeToHHMM('18.00'), '18:00')
  assert.equal(parseTimeToHHMM(0.75), '18:00')
  assert.equal(parseTimeToHHMM('bad'), '--:--')
})
test('dated Friday lesson appears on its date and recurring Friday lessons appear weekly', () => {
  const friday = new Date(2026, 9, 2, 16, 30)
  const saturday = new Date(2026, 9, 3, 16, 30)
  assert.equal(isLessonOnDay(lesson('2026-10-02', 'Пт'), friday), true)
  assert.equal(isLessonOnDay(lesson('2026-10-02', 'Пт'), saturday), false)
  assert.equal(isLessonOnDay(lesson(null, 'Пт', true), friday), true)
  assert.equal(isLessonOnDay(lesson(null, 'Пт', false), friday), false)
})

test('recurring lesson resolves each displayed week and respects its start date', () => {
  const started = lesson('2026-10-02', 'Пт', true)
  const firstWeek = new Date(2026, 8, 28)
  const secondWeek = new Date(2026, 9, 5)
  assert.equal(lessonOccurrenceDate(started, firstWeek), '2026-10-02')
  assert.equal(lessonOccurrenceDate(started, secondWeek), '2026-10-09')
  assert.equal(isLessonInWeek(started, secondWeek, new Date(2026, 9, 11)), true)
  assert.equal(isLessonOnDay(started, new Date(2026, 9, 9)), true)
  assert.equal(isLessonOnDay(started, new Date(2026, 8, 25)), false)
})
