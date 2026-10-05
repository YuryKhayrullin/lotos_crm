const test = require('node:test')
const assert = require('node:assert/strict')
const {
  rememberAttendanceDraft,
  getAttendanceDraft,
  clearAttendanceDrafts,
  forgetAttendanceDraft,
  isDefiniteAttendanceRejection,
  summarizeAttendance,
} = require('../.test-dist/attendance-recovery.js')

test('attendance drafts survive screen recovery and are isolated and cleared at sign out', () => {
  clearAttendanceDrafts()
  const draft = {
    attendance: { child: 'attended' },
    initialAttendance: { child: null },
    pendingAttempt: {
      requestId: 'same-request',
      lessonId: 'lesson',
      date: '2026-10-04',
      attendanceList: [{ clientId: 'child', status: 'attended' }],
    },
  }
  rememberAttendanceDraft('coach-1:session-1:lesson', draft)
  assert.equal(getAttendanceDraft('coach-1:session-1:lesson').pendingAttempt.requestId, 'same-request')
  assert.equal(getAttendanceDraft('coach-2:session-1:lesson'), undefined)
  forgetAttendanceDraft('coach-1:session-1:lesson')
  assert.equal(getAttendanceDraft('coach-1:session-1:lesson'), undefined)
  rememberAttendanceDraft('coach-1:session-1:lesson', draft)
  clearAttendanceDrafts()
  assert.equal(getAttendanceDraft('coach-1:session-1:lesson'), undefined)
})

test('only definitive rejected writes unlock edits; transport and partial writes keep the same attempt', () => {
  for (const status of [400, 401, 403, 404, 409, 422]) assert.equal(isDefiniteAttendanceRejection({ status }), true)
  for (const status of [500, 502, 503, 504]) assert.equal(isDefiniteAttendanceRejection({ status }), false)
  assert.equal(isDefiniteAttendanceRejection(new Error('network')), false)
  assert.equal(isDefiniteAttendanceRejection({ status: 409, attendanceOutcomeUnknown: true }), false)
})

test('attendance summary is linear, counts only roster pupils, and sends only changed nonempty marks', () => {
  let reads = 0
  const roster = Array.from({ length: 500 }, (_, index) => ({
    get id() {
      reads++
      return `child-${index}`
    },
  }))
  const attendance = { 'child-0': 'attended', 'child-1': 'absent', 'child-2': null, stale: 'attended' }
  const summary = summarizeAttendance(roster, attendance, { 'child-0': 'attended', 'child-1': null })
  assert.deepEqual(summary, {
    changedEntries: [['child-1', 'absent']],
    attendedCount: 1,
    absentCount: 1,
    unmarkedCount: 498,
  })
  assert.ok(reads <= 510, 'one pass, not a roster search for every mark')
})
