const test = require('node:test')
const assert = require('node:assert/strict')
const {
  GAS_ERROR_CODES,
  codeForHttpStatus,
  isGasErrorCode,
  messageForGasErrorCode,
  statusForGasErrorCode,
} = require('../.test-dist/server/api-errors.js')

test('GAS machine codes map to the public HTTP contract', () => {
  assert.deepEqual(GAS_ERROR_CODES, [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'VALIDATION',
    'NOT_FOUND',
    'CONFLICT',
    'BUSY',
    'SCHEMA',
  ])
  assert.equal(statusForGasErrorCode('UNAUTHORIZED'), 401)
  assert.equal(statusForGasErrorCode('FORBIDDEN'), 403)
  assert.equal(statusForGasErrorCode('VALIDATION'), 400)
  assert.equal(statusForGasErrorCode('NOT_FOUND'), 404)
  assert.equal(statusForGasErrorCode('CONFLICT'), 409)
  assert.equal(statusForGasErrorCode('BUSY'), 503)
  assert.equal(statusForGasErrorCode('SCHEMA'), 503)
})

test('unknown upstream codes fail closed and public messages contain no diagnostics', () => {
  assert.equal(isGasErrorCode('VALIDATION'), true)
  assert.equal(isGasErrorCode('signature.hmac'), false)
  assert.equal(codeForHttpStatus(503), 'SERVICE_UNAVAILABLE')
  for (const code of GAS_ERROR_CODES) {
    const message = messageForGasErrorCode(code)
    assert.doesNotMatch(message, /build|setupSchema|script propert|stack|exception/i)
  }
})
