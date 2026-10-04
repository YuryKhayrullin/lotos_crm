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
  assert.match(gas, /function doGet\(\)[\s\S]*apiErrorPayload\('UNAUTHORIZED'\)/)
  assert.match(gas, /function options\(\)[\s\S]*apiErrorPayload\('UNAUTHORIZED'\)/)
  assert.doesNotMatch(gas, /console\.(log|error|warn)\s*\(/)
})

test('GAS and BFF expose only machine-coded, sanitized errors', () => {
  const gasClient = fs.readFileSync(path.join(root, 'lib', 'server', 'gas.ts'), 'utf8')
  const apiClient = fs.readFileSync(path.join(root, 'lib', 'api-client.ts'), 'utf8')
  const devLog = fs.readFileSync(path.join(root, 'lib', 'dev-log.ts'), 'utf8')
  const authStore = fs.readFileSync(path.join(root, 'store', 'AuthStore.ts'), 'utf8')
  const rootStore = fs.readFileSync(path.join(root, 'store', 'RootStore.ts'), 'utf8')

  for (const code of ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'BUSY', 'SCHEMA']) {
    assert.match(gas, new RegExp("'" + code + "'"))
  }
  assert.match(gas, /return \{ status: 'error', code: code, message: publicApiErrorMessage\(code\) \}/)
  assert.doesNotMatch(gas, /LOTOS_BACKEND_BUILD|build:\s*LOTOS|message:\s*String\(err/)
  assert.doesNotMatch(gasClient, /\.build|diagnosticMessage|unauthorized.*test\(message\)/i)
  assert.doesNotMatch(apiClient, /console\.log|\$\{action\}: \$\{message\}/)
  assert.match(devLog, /process\.env\.NODE_ENV !== 'production'/)
  assert.doesNotMatch(devLog, /password|token|phone|payload|requestBody/i)
  assert.doesNotMatch(authStore, /console\.log/)
  assert.doesNotMatch(rootStore, /console\.log/)
  assert.doesNotMatch(session, /console\.log/)
  assert.match(session, /error instanceof GasError && error\.status === 503\) throw error/)
  assert.match(session, /new SessionError\('Сервис авторизации временно недоступен', 503\)/)
  assert.doesNotMatch(bff, /console\.log|console\.warn|console\.error/)
  assert.match(bff, /code: 'UNAUTHORIZED',[\s\S]*authenticated: false[\s\S]*401/)
  assert.match(bff, /return jsonError\(error\.publicMessage, error\.status, error\.code\)/)
})

test('GAS classifies business failures without returning their internal text', () => {
  const context = { Logger: { log() {} } }
  vm.createContext(context)
  vm.runInContext(gas, context)

  const cases = [
    ['Unauthorized', 'UNAUTHORIZED'],
    ['Доступ к филиалу запрещен', 'FORBIDDEN'],
    ['Некорректная дата рождения', 'VALIDATION'],
    ['Клиент не найден', 'NOT_FOUND'],
    ['Этот requestId уже использован с другими данными', 'CONFLICT'],
    ['Система занята, повторите операцию', 'BUSY'],
    ['Схема клиентов не обновлена. Запустите setupSchema()', 'SCHEMA'],
  ]

  for (const [internalMessage, expectedCode] of cases) {
    const payload = context.apiErrorPayload(new Error(internalMessage))
    assert.equal(payload.code, expectedCode)
    assert.notEqual(payload.message, internalMessage)
  }
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
  const attendanceModal = fs.readFileSync(path.join(root, 'components', 'AttendanceModal.tsx'), 'utf8')
  assert.match(gas, /LockService\.getScriptLock\(\)/)
  assert.match(gas, /requestId/)
  assert.match(gas, /previousCharged/)
  assert.match(gas, /Проходные посетители не поддерживаются/)
  assert.doesNotMatch(gas, /function processWalkinAttendance/)
  assert.doesNotMatch(attendanceModal, /Walk-in|проходного посетителя/i)
})

test('BFF and GAS use a signed, replay-resistant envelope', () => {
  const gasClient = fs.readFileSync(path.join(root, 'lib', 'server', 'gas.ts'), 'utf8')
  assert.match(gasClient, /createHmac\('sha256'/)
  assert.match(gasClient, /randomUUID\(\)/)
  assert.match(gasClient, /GAS_HMAC_SECRET/)
  assert.doesNotMatch(gasClient, /apiKey/)
  assert.match(gas, /function verifySignedEnvelope/)
  assert.match(gas, /GAS_HMAC_SECRET/)
  assert.doesNotMatch(gas, /apiKey/)
  assert.match(gas, /gas-nonce:/)
})

test('BFF requires the HttpOnly session and applies the action policy', () => {
  assert.match(bff, /getSession\(\{[\s\S]*revalidate/)
  assert.match(crmRouter, /assertActionAllowed\(action, user\)/)
  assert.match(crmRouter, /withBranchScope\(credentialSafePayload, user\)/)
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
  assert.match(gas, /BOOTSTRAP_ADMIN_PASSWORD_HASH/)
  assert.match(gas, /properties\.deleteProperty\('BOOTSTRAP_ADMIN_PASSWORD_HASH'\)/)

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
    () =>
      context.requireServerAuth({
        action: 'getClients',
        auth: { id: 'coach-1', username: 'coach', role: 'coach', branchId: 'branch-1' },
      }),
    /Unauthorized/,
  )
})

test('lesson balance is ledger-owned across API, UI and legacy data audit', () => {
  const apiClient = fs.readFileSync(path.join(root, 'lib', 'api-client.ts'), 'utf8')
  const normalizers = fs.readFileSync(path.join(root, 'lib', 'normalizers.ts'), 'utf8')
  const clientStore = fs.readFileSync(path.join(root, 'store', 'ClientStore.ts'), 'utf8')
  const clientModel = fs.readFileSync(path.join(root, 'store', 'models', 'Client.ts'), 'utf8')

  assert.doesNotMatch(gas, /addLessons/)
  assert.match(gas, /function recordAdjustment\(/)
  assert.match(gas, /function auditLessonLedger\(/)
  assert.match(gas, /function repairLessonLedger\(/)
  assert.equal(gas.includes('rejectLedgerOwnedClientFields(body)'), true)
  assert.match(gas, /Квитанция не начисляет занятия/)
  assert.match(apiClient, /recordAdjustment/)
  assert.match(apiClient, /auditLessonLedger/)
  assert.match(apiClient, /repairLessonLedger/)
  assert.doesNotMatch(apiClient, /addLessons/)
  assert.doesNotMatch(normalizers, /packageLessonsFromFrequency|countAttendedLessons/)
  assert.doesNotMatch(clientStore, /updateClientPayment|markAttendance/)
  assert.doesNotMatch(clientModel, /updateSubscription|consumeLesson/)
})

test('dead edit actions are absent while client editing remains connected to the UI', () => {
  const apiClient = fs.readFileSync(path.join(root, 'lib', 'api-client.ts'), 'utf8')
  const rootStore = fs.readFileSync(path.join(root, 'store', 'RootStore.ts'), 'utf8')
  const clientStore = fs.readFileSync(path.join(root, 'store', 'ClientStore.ts'), 'utf8')
  const clientsView = fs.readFileSync(path.join(root, 'components', 'ClientsView.tsx'), 'utf8')

  assert.doesNotMatch(gas, /updateCoach/)
  assert.doesNotMatch(apiClient, /updateCoach|updateClientAPI/)
  assert.doesNotMatch(rootStore, /startEdit|updateCoach|editingCoach/)
  assert.doesNotMatch(clientStore, /markAttendance|updateClientPayment/)
  assert.match(apiClient, /async updateClient\(/)
  assert.match(clientsView, /apiClient\.updateClient\(/)
})

test('all CRM mutations share a lock and administrative changes have a privacy-safe audit trail', () => {
  assert.match(gas, /var SCHEMA_VERSION = '12'/)
  assert.match(gas, /function writeChangedRowCells\(/)
  assert.match(gas, /function appendAdminAudit\(/)
  assert.match(gas, /function onEdit\(e\)/)
  assert.match(gas, /configureAccountingColumnProtections\(clients\)/)
  assert.match(gas, /invalidateReadCache\(\);?/)
  assert.match(gas, /if \(isMutatingAction\(body\.action\)\)/)
  assert.match(gas, /if \(isMutatingAction\(body\.action\)\) \{[\s\S]*getScriptLock\(\)/)
  assert.doesNotMatch(gas, /context\.sheet\.getRange\(rowIndex \+ 1, 1, 1, context\.headers\.length\)\.setValues/)
  assert.doesNotMatch(gas, /passwordHash.*changedFields|changedFields.*passwordHash/)
})
