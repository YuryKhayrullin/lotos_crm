const test = require('node:test')
const assert = require('node:assert/strict')
const { assertActionAllowed, withBranchScope } = require('../.test-dist/server/policy.js')

const admin = { id: '1', username: 'admin', role: 'admin', branchId: null }
const coach = { id: '2', username: 'coach', role: 'coach', branchId: 'branch-a' }

test('admin can use administrative actions', () => {
  assert.doesNotThrow(() => assertActionAllowed('createClient', admin))
  assert.doesNotThrow(() => assertActionAllowed('uploadReceipt', admin))
  assert.doesNotThrow(() => assertActionAllowed('deactivateUser', admin))
  assert.doesNotThrow(() => assertActionAllowed('resetCoachPassword', admin))
  assert.doesNotThrow(() => assertActionAllowed('recordAdjustment', admin))
  assert.doesNotThrow(() => assertActionAllowed('auditLessonLedger', admin))
  assert.doesNotThrow(() => assertActionAllowed('repairLessonLedger', admin))
  assert.doesNotThrow(() => assertActionAllowed('getFinanceSummary', admin))
  assert.doesNotThrow(() => assertActionAllowed('getSubscriptionsPage', admin))
  assert.doesNotThrow(() => assertActionAllowed('assignClientLesson', admin))
})

test('coach cannot use administrative actions', () => {
  assert.throws(() => assertActionAllowed('createClient', coach), /Недостаточно прав/)
  assert.throws(() => assertActionAllowed('deleteCoach', coach), /Недостаточно прав/)
  assert.throws(() => assertActionAllowed('deactivateUser', coach), /Недостаточно прав/)
  assert.throws(() => assertActionAllowed('recordAdjustment', coach), /Недостаточно прав/)
  assert.throws(() => assertActionAllowed('auditLessonLedger', coach), /Недостаточно прав/)
  assert.throws(() => assertActionAllowed('getFinanceSummary', coach), /Недостаточно прав/)
  assert.throws(() => assertActionAllowed('getSubscriptionsPage', coach), /Недостаточно прав/)
  assert.throws(() => assertActionAllowed('assignClientLesson', coach), /Недостаточно прав/)
  assert.doesNotThrow(() => assertActionAllowed('getDashboardSummary', coach))
  assert.doesNotThrow(() => assertActionAllowed('searchClientOptions', coach))
  assert.doesNotThrow(() => assertActionAllowed('getBootstrapData', coach))
})

test('coach is restricted to the assigned branch', () => {
  assert.deepEqual(withBranchScope({ branchId: 'other', title: 'lesson' }, coach), {
    branchId: 'branch-a',
    title: 'lesson',
  })
})

test('unknown actions are rejected', () => {
  assert.throws(() => assertActionAllowed('dropDatabase', admin), /Недопустимое действие/)
  // Registration must pass only through its rate-limited public auth route.
  assert.throws(() => assertActionAllowed('registerCoach', admin), /Недопустимое действие/)
  assert.throws(() => assertActionAllowed('registerCoach', coach), /Недопустимое действие/)
})
