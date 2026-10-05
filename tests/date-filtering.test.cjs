const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const {
  isLessonInWeek,
  isLessonOnDay,
  lessonOccurrenceDate,
  parseTimeToHHMM,
  lessonTemporalStatus,
} = require('../.test-dist/utils/date-core.js')

const lesson = (date, dayOfWeek, isRecurring = false) => ({ date, dayOfWeek, isRecurring })
const weekStart = new Date('2026-09-21T00:00:00')
const weekEnd = new Date('2026-09-27T00:00:00')

test('schedule separates upcoming, ongoing and completed at exact start and end boundaries', () => {
  const status = (hour, minute = 0) =>
    lessonTemporalStatus('2026-10-05', '17:00', '1 час', new Date(2026, 9, 5, hour, minute))
  assert.equal(status(16, 59), 'upcoming')
  assert.equal(status(17), 'ongoing')
  assert.equal(status(17, 59), 'ongoing')
  assert.equal(status(18), 'completed')
  assert.equal(status(19, 41), 'completed')
  assert.equal(lessonTemporalStatus('2026-10-05', '21:00', '1 час', new Date(2026, 9, 5, 19, 41)), 'upcoming')
  assert.equal(lessonTemporalStatus('2026-10-05', '23:30', '1 час 30 мин', new Date(2026, 9, 6, 0, 30)), 'ongoing')
  assert.equal(lessonTemporalStatus('2026-10-05', '17:00', '45 мин', new Date(2026, 9, 5, 17, 45)), 'completed')
  assert.equal(lessonTemporalStatus(null, '17:00', '1 час', new Date()), 'unknown')
  assert.equal(lessonTemporalStatus('2026-10-05', '17:00', 'не указана', new Date(2026, 9, 5, 18)), 'unknown')
})

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

test('date-only and recurring lesson logic does not shift across supported time zones', () => {
  const modulePath = path.resolve(__dirname, '..', '.test-dist', 'utils', 'date-core.js')
  const script = `
    const dates = require(${JSON.stringify(modulePath)});
    const target = new Date(2026, 9, 2, 23, 30);
    const result = {
      dateOnly: dates.isLessonOnDay({ date: '2026-10-02T00:00:00.000Z', dayOfWeek: 'Пт' }, target),
      recurring: dates.lessonOccurrenceDate(
        { date: '2026-10-02', dayOfWeek: 'Пт', isRecurring: true },
        new Date(2026, 8, 28),
      ),
    };
    process.stdout.write(JSON.stringify(result));
  `

  for (const timezone of ['Europe/Moscow', 'America/Los_Angeles', 'Pacific/Auckland']) {
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, TZ: timezone },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { dateOnly: true, recurring: '2026-10-02' })
  }
})
