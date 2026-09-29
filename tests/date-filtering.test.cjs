const test = require('node:test')
const assert = require('node:assert/strict')
const { isLessonInWeek, isLessonOnDay, parseTimeToHHMM } = require('../.test-dist/utils/date-core.js')

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
