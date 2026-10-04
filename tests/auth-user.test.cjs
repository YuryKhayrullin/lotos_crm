const test = require('node:test')
const assert = require('node:assert/strict')
const { isActiveAuthUser } = require('../.test-dist/server/auth-user.js')

const candidate = {
  id: 'coach-1',
  username: 'coach',
  passwordHash: 'scrypt$hash',
  role: 'coach',
  branchId: 'branch-1',
  status: 'Активен',
}

test('only an active, complete user can pass the BFF login gate', () => {
  assert.equal(isActiveAuthUser(candidate), true)
  assert.equal(isActiveAuthUser({ ...candidate, status: 'Отключен' }), false)
  assert.equal(isActiveAuthUser({ ...candidate, passwordHash: undefined }), false)
  assert.equal(isActiveAuthUser({ ...candidate, role: 'viewer' }), false)
})
