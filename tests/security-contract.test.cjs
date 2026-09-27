const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const gas = fs.readFileSync(path.join(root, 'backend', 'Code.gs'), 'utf8')
const bff = fs.readFileSync(path.join(root, 'app', 'api', 'crm', 'route.ts'), 'utf8')
const session = fs.readFileSync(path.join(root, 'lib', 'server', 'session.ts'), 'utf8')

test('GAS fails closed and does not log request bodies', () => {
  assert.match(gas, /!scriptSecret\s*\|\|\s*scriptSecret\.length\s*<\s*32/)
  assert.match(gas, /function doGet\(\)[\s\S]*Unauthorized/)
  assert.match(gas, /function options\(\)[\s\S]*Unauthorized/)
  assert.doesNotMatch(gas, /console\.(log|error|warn)\s*\(/)
})

test('attendance contract contains lock, idempotency and correction handling', () => {
  assert.match(gas, /LockService\.getScriptLock\(\)/)
  assert.match(gas, /requestId/)
  assert.match(gas, /previousCharged/)
  assert.match(gas, /processWalkinAttendance/)
})

test('BFF requires the HttpOnly session and applies the action policy', () => {
  assert.match(bff, /getSession\(\)/)
  assert.match(bff, /assertActionAllowed\(action, user\)/)
  assert.match(bff, /withBranchScope\(safePayload\(body\.payload\), user\)/)
})

test('session is signed and HttpOnly without browser storage', () => {
  assert.match(session, /httpOnly:\s*true/)
  assert.match(session, /SignJWT/)
  assert.doesNotMatch(session, /localStorage|sessionStorage/)
})
