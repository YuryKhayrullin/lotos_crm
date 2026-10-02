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
})

test('coach cannot use administrative actions', () => {
  assert.throws(() => assertActionAllowed('createClient', coach), /Недостаточно прав/)
  assert.throws(() => assertActionAllowed('deleteCoach', coach), /Недостаточно прав/)
  assert.throws(() => assertActionAllowed('deactivateUser', coach), /Недостаточно прав/)
})

test('coach is restricted to the assigned branch', () => {
  assert.deepEqual(withBranchScope({ branchId: 'other', title: 'lesson' }, coach), {
    branchId: 'branch-a',
    title: 'lesson',
  })
})

test('unknown actions are rejected', () => {
  assert.throws(() => assertActionAllowed('dropDatabase', admin), /Недопустимое действие/)
})
