const test = require('node:test')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.resolve(__dirname, '..')
const gas = fs.readFileSync(path.join(root, 'backend', 'Code.gs'), 'utf8')
const bff = fs.readFileSync(path.join(root, 'app', 'api', '[[...path]]', 'route.ts'), 'utf8')
const crmRouter = fs.readFileSync(path.join(root, 'lib', 'server', 'crm-router.ts'), 'utf8')
const session = fs.readFileSync(path.join(root, 'lib', 'server', 'session.ts'), 'utf8')
const gasUtilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  computeDigest: (_algorithm, value) => Array.from(crypto.createHash('sha256').update(String(value)).digest()),
}

test('GAS fails closed and does not log request bodies', () => {
  assert.match(gas, /!scriptSecret\s*\|\|\s*scriptSecret\.length\s*<\s*32/)
  assert.match(gas, /function doGet\(\)[\s\S]*Unauthorized/)
  assert.match(gas, /function options\(\)[\s\S]*Unauthorized/)
  assert.doesNotMatch(gas, /console\.(log|error|warn)\s*\(/)
})

test('GAS canonicalizes Users data instead of rejecting stale session claims', () => {
  const rows = [
    ['id', 'username', 'password', 'role', 'branchId', 'status', 'disabledAt', 'disabledBy'],
    [' user-1 ', ' Administrator ', 'hash', ' 1 ', ' branch-1 ', 'Активен', '', ''],
  ]
  const context = {
    console,
    Logger: { log() {} },
    Utilities: gasUtilities,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: () => ({
          getLastColumn: () => rows[0].length,
          getRange: () => ({ getValues: () => [rows[0]] }),
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

test('GAS caches read auth and bypasses cache for mutations', () => {
  const rows = [
    ['id', 'username', 'password', 'role', 'branchId', 'status', 'disabledAt', 'disabledBy'],
    ['user-1', 'Administrator', 'hash', '1', 'branch-1', 'Активен', '', ''],
  ]
  let sheetReads = 0
  const cacheValues = new Map()
  const cache = {
    get: (key) => cacheValues.get(key) || null,
    put: (key, value) => cacheValues.set(key, value),
    remove: (key) => cacheValues.delete(key),
  }
  const context = {
    console,
    Logger: { log() {} },
    Utilities: gasUtilities,
    CacheService: { getScriptCache: () => cache },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: () => ({
          getLastColumn: () => rows[0].length,
          getRange: () => ({ getValues: () => [rows[0]] }),
          getDataRange: () => ({
            getValues: () => {
              sheetReads += 1
              return rows.map((row) => row.slice())
            },
          }),
        }),
      }),
    },
  }
  vm.createContext(context)
  vm.runInContext(gas, context)

  const claims = { id: 'user-1', username: 'Administrator', role: 'admin', branchId: 'branch-1' }
  context.requireServerAuth({ action: 'getClients', auth: claims })
  context.requireServerAuth({ action: 'getClients', auth: claims })
  assert.equal(sheetReads, 1)

  rows[1][3] = '2'
  rows[1][4] = 'branch-2'
  const cachedRead = context.requireServerAuth({ action: 'getClients', auth: claims })
  assert.equal(cachedRead.role, 'admin')
  assert.equal(cachedRead.branchId, 'branch-1')
  assert.equal(sheetReads, 1)

  const freshMutation = context.requireServerAuth({ action: 'updateClient', auth: claims })
  assert.equal(freshMutation.role, 'coach')
  assert.equal(freshMutation.branchId, 'branch-2')
  assert.equal(sheetReads, 2)
  assert.equal(cacheValues.size, 0)

  const freshSession = context.requireServerAuth({ action: 'getCurrentUser', auth: claims })
  assert.equal(freshSession.role, 'coach')
  assert.equal(sheetReads, 3)
  assert(cacheValues.size === 0)

  const authIndex = gas.indexOf('auth = requireServerAuth(body)')
  const cachedResponseIndex = gas.indexOf('if (cachedMutationResponse) {')
  assert(authIndex >= 0 && authIndex < cachedResponseIndex)
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


test('public registration is absent and a disabled account is rejected even with a valid old session', () => {
  assert.doesNotMatch(bff, /auth', 'register|auth\/register|handleRegister/)
  assert.doesNotMatch(gas, /body\.action === 'register'/)
  assert.match(gas, /function setupInitialAdmin\(\)/)
  assert.match(gas, /BOOTSTRAP_ADMIN_USERNAME/)
  assert.match(gas, /properties\.deleteProperty\('BOOTSTRAP_ADMIN_PASSWORD'\)/)

  const rows = [
    ['id', 'username', 'password', 'role', 'branchId', 'status', 'disabledAt', 'disabledBy'],
    ['coach-1', 'coach', 'hash', '2', 'branch-1', 'Отключен', '2026-10-02T10:00:00.000Z', 'admin'],
  ]
  const context = {
    Logger: { log() {} },
    Utilities: gasUtilities,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: () => ({
          getLastColumn: () => rows[0].length,
          getRange: () => ({ getValues: () => [rows[0]] }),
          getDataRange: () => ({ getValues: () => rows }),
        }),
      }),
    },
  }
  vm.createContext(context)
  vm.runInContext(gas, context)
  assert.throws(
    () => context.requireServerAuth({ action: 'getClients', auth: { id: 'coach-1', username: 'coach', role: 'coach', branchId: 'branch-1' } }),
    /Unauthorized/,
  )
})
