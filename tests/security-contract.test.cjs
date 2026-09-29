const test = require('node:test')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const gas = fs.readFileSync(path.join(root, 'backend', 'Code.gs'), 'utf8')
const bff = fs.readFileSync(path.join(root, 'app', 'api', '[[...path]]', 'route.ts'), 'utf8')
const crmRouter = fs.readFileSync(path.join(root, 'lib', 'server', 'crm-router.ts'), 'utf8')
const session = fs.readFileSync(path.join(root, 'lib', 'server', 'session.ts'), 'utf8')

test('GAS fails closed and does not log request bodies', () => {
  assert.match(gas, /!scriptSecret\s*\|\|\s*scriptSecret\.length\s*<\s*32/)
  assert.match(gas, /function doGet\(\)[\s\S]*Unauthorized/)
  assert.match(gas, /function options\(\)[\s\S]*Unauthorized/)
  assert.doesNotMatch(gas, /console\.(log|error|warn)\s*\(/)
})

test('GAS canonicalizes Users data instead of rejecting stale session claims', () => {
  const rows = [
    ['id', 'username', 'password', 'role', 'branchId'],
    [' user-1 ', ' Administrator ', 'hash', ' 1 ', ' branch-1 '],
  ]
  const context = {
    console,
    Logger: { log() {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: () => ({
          getDataRange: () => ({ getValues: () => rows }),
        }),
      }),
    },
  }
  vm.createContext(context)
  vm.runInContext(gas, context)

  const user = context.requireServerAuth({
    auth: { id: 'user-1', username: 'stale-name', role: 'coach', branchId: 'old-branch' },
  })

  assert.equal(user.id, 'user-1')
  assert.equal(user.username, 'Administrator')
  assert.equal(user.role, 'admin')
  assert.equal(user.branchId, 'branch-1')
  assert.match(gas, /id: auth.id/)
})

test('attendance contract contains lock, idempotency and correction handling', () => {
  assert.match(gas, /LockService\.getScriptLock\(\)/)
  assert.match(gas, /requestId/)
  assert.match(gas, /previousCharged/)
  assert.match(gas, /processWalkinAttendance/)
})

test('BFF and GAS use a signed, replay-resistant envelope', () => {
  const gasClient = fs.readFileSync(path.join(root, 'lib', 'server', 'gas.ts'), 'utf8')
  assert.match(gasClient, /createHmac\('sha256'/)
  assert.match(gasClient, /randomUUID\(\)/)
  assert.match(gas, /function verifySignedEnvelope/)
  assert.match(gas, /gas-nonce:/)
})

test('BFF requires the HttpOnly session and applies the action policy', () => {
  assert.match(bff, /getSession\(\{[\s\S]*revalidate/)
  assert.match(crmRouter, /assertActionAllowed\(action, user\)/)
  assert.match(crmRouter, /withBranchScope\(payload, user\)/)
  assert.match(bff, /dispatchCrmAction\(\{ action, payload, user \}\)/)
})

test('generic client edits cannot overwrite payment-ledger fields', () => {
  assert.match(gas, /clientSubscriptionFields\s*=\s*\[[\s\S]*'paidAmount'/)
})

test('session is signed and HttpOnly without browser storage', () => {
  assert.match(session, /httpOnly:\s*true/)
  assert.match(session, /SignJWT/)
  assert.doesNotMatch(session, /localStorage|sessionStorage/)
})
