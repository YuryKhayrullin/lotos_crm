const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const gas = fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8')

const PAYMENT_HEADERS = [
  'id',
  'requestId',
  'clientId',
  'branchId',
  'amount',
  'category',
  'lessonsPerWeek',
  'packagePrice',
  'packageLessons',
  'packagesCount',
  'lessonsAdded',
  'paidAt',
  'recordedBy',
  'comment',
  'requestFingerprint',
]
const LEDGER_HEADERS = [
  'id',
  'requestId',
  'clientId',
  'branchId',
  'paymentId',
  'type',
  'lessonsDelta',
  'totalLessonsDelta',
  'balanceBefore',
  'balanceAfter',
  'totalLessonsBefore',
  'totalLessonsAfter',
  'createdAt',
  'recordedBy',
  'comment',
  'reason',
  'requestFingerprint',
]
function ledgerRow({
  id = 'ledger-' + Math.random(),
  requestId = 'legacy-request',
  clientId,
  branchId = 'branch-1',
  paymentId = '',
  type = 'audit_repair',
  lessonsDelta = 0,
  totalLessonsDelta = 0,
  balanceAfter = 0,
  totalLessonsAfter = 0,
  balanceBefore = balanceAfter - lessonsDelta,
  totalLessonsBefore = totalLessonsAfter - totalLessonsDelta,
  recordedBy = 'admin',
  comment = '',
  reason = 'legacy import',
  requestFingerprint = '',
}) {
  return [
    id,
    requestId,
    clientId,
    branchId,
    paymentId,
    type,
    lessonsDelta,
    totalLessonsDelta,
    balanceBefore,
    balanceAfter,
    totalLessonsBefore,
    totalLessonsAfter,
    '2026-10-02T00:00:00.000Z',
    recordedBy,
    comment,
    reason,
    requestFingerprint,
  ]
}

function createHarness(sheetData, { allowUnlockedReads = false } = {}) {
  const state = { held: false, acquisitions: 0, events: [], writes: [], formats: [], driveFiles: [] }
  const sheets = new Map()
  let nextSheetId = 1

  const makeSheet = (name, initialRows = []) => {
    const sheetId = nextSheetId++
    const data = initialRows.map((row) => row.slice())
    const assertLocked = () => assert.equal(state.held, true, name + ' accessed outside the mutation lock')
    return {
      rows: data,
      getName: () => name,
      getSheetId: () => sheetId,
      getLastColumn: () => (data[0] ? data[0].length : 0),
      getLastRow: () => data.length,
      getMaxRows: () => Math.max(1000, data.length),
      getDataRange: () => ({
        getValues: () => {
          if (!allowUnlockedReads) assertLocked()
          state.events.push('read:' + name)
          return data.map((row) => row.slice())
        },
      }),
      getRange: (row, column, height = 1, width = 1) => ({
        getValues: () => {
          if (!allowUnlockedReads) assertLocked()
          state.events.push('read:' + name)
          return data.slice(row - 1, row - 1 + height).map((values) => values.slice(column - 1, column - 1 + width))
        },
        setValues: (values) => {
          assertLocked()
          state.writes.push({ name, row, column, height, width })
          values.forEach((valuesRow, rowOffset) => {
            if (!data[row - 1 + rowOffset]) data[row - 1 + rowOffset] = []
            valuesRow.forEach((value, columnOffset) => {
              data[row - 1 + rowOffset][column - 1 + columnOffset] = value
            })
          })
        },
        setValue: (value) => {
          assertLocked()
          state.writes.push({ name, row, column, height: 1, width: 1 })
          data[row - 1][column - 1] = value
        },
        setNumberFormat: (format) => {
          assertLocked()
          state.formats.push({ name, row, column, height, width, format })
        },
      }),
      appendRow: (row) => {
        assertLocked()
        data.push(row.slice())
        state.writes.push({ name, append: true })
      },
      deleteRow: (row) => {
        assertLocked()
        data.splice(row - 1, 1)
        state.writes.push({ name, delete: row })
      },
    }
  }

  for (const [name, rows] of Object.entries(sheetData)) sheets.set(name, makeSheet(name, rows))

  const cacheValues = new Map()
  const cache = {
    get: (key) => cacheValues.get(key) || null,
    put: (key, value) => cacheValues.set(key, value),
    remove: (key) => cacheValues.delete(key),
  }
  const properties = new Map([
    ['GAS_HMAC_SECRET', 's'.repeat(32)],
    ['SCHEMA_VERSION', '12'],
    ['READ_CACHE_VERSION', '1'],
  ])
  const lock = {
    tryLock: () => {
      assert.equal(state.held, false, 'nested script lock')
      state.held = true
      state.acquisitions += 1
      state.events.push('lock')
      return true
    },
    releaseLock: () => {
      assert.equal(state.held, true)
      state.events.push('unlock')
      state.held = false
    },
  }
  const context = {
    Logger: { log() {} },
    LockService: { getScriptLock: () => lock },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getId: () => 'test-spreadsheet',
        getSheetByName: (name) => sheets.get(name) || null,
        insertSheet: (name) => {
          if (sheets.has(name)) throw new Error('Sheet already exists: ' + name)
          const sheet = makeSheet(name)
          sheets.set(name, sheet)
          return sheet
        },
      }),
      flush: () => {
        assert.equal(state.held, true)
        state.events.push('flush')
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (name) => properties.get(name) || null,
        setProperty: (name, value) => {
          if (name === 'READ_CACHE_VERSION') state.events.push('invalidate')
          properties.set(name, value)
        },
        deleteProperty: (name) => properties.delete(name),
      }),
    },
    CacheService: { getScriptCache: () => cache },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (value) => ({
        value,
        setMimeType() {
          return this
        },
      }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (_algorithm, value) => Array.from(crypto.createHash('sha256').update(String(value)).digest()),
      computeHmacSha256Signature: (value, key) =>
        Array.from(crypto.createHmac('sha256', String(key)).update(String(value)).digest()),
      getUuid: () => '12345678-1234-1234-1234-123456789abc',
      base64Decode: (value) => Array.from(Buffer.from(String(value), 'base64')),
      newBlob: (bytes, mimeType, fileName) => ({ bytes, mimeType, fileName }),
    },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE' },
      Permission: { NONE: 'NONE' },
      createFile: (blob) => {
        const record = { id: 'drive-file-' + (state.driveFiles.length + 1), blob, sharing: null }
        state.driveFiles.push(record)
        return {
          getId: () => record.id,
          setSharing: (access, permission) => {
            record.sharing = { access, permission }
          },
        }
      },
    },
  }
  vm.createContext(context)
  vm.runInContext(gas, context)
  const canonicalRequireServerAuth = context.requireServerAuth
  context.requireServerAuth = () => ({ id: 'admin-1', username: 'admin', role: 'admin', branchId: null })
  context.verifySignedEnvelope = () => state.envelope

  function request(action, payload) {
    state.envelope = { action, payload, auth: { id: 'admin-1', role: 'admin' } }
    const response = context.doPost({
      postData: { contents: JSON.stringify({ signature: '0'.repeat(64), signedEnvelope: 'test' }) },
    })
    return JSON.parse(response.value)
  }

  return { request, state, sheets, cacheValues, properties, context, canonicalRequireServerAuth }
}

const REGISTRATION_HEADERS = ['id', 'username', 'password', 'role', 'branchId', 'status', 'disabledAt', 'disabledBy']
const REGISTRATION_HASH = 'scrypt$16384$8$1$' + 'a'.repeat(22) + '$' + 'b'.repeat(86)
const registrationPayload = (changes = {}) => ({
  username: 'new.coach',
  passwordHash: REGISTRATION_HASH,
  requestId: 'register-1',
  ...changes,
})

test('public registration creates only a pending unscoped coach under the shared mutation lock', () => {
  const harness = createHarness({ Users: [REGISTRATION_HEADERS] })
  harness.context.requireServerAuth = () => assert.fail('a public pending registration does not require a session')
  const result = harness.request(
    'registerCoach',
    registrationPayload({ role: '1', branchId: 'other-branch', status: 'Активен', disabledBy: 'forged' }),
  )
  assert.deepEqual(result, { status: 'success', pending: true })
  const rows = harness.sheets.get('Users').rows
  assert.equal(rows.length, 2)
  assert(rows[1][0])
  assert.deepEqual(rows[1].slice(1), ['new.coach', REGISTRATION_HASH, '2', '', 'Ожидает подтверждения', '', ''])
  assert.equal(harness.state.acquisitions, 1)
  assert.equal(harness.state.held, false)
  assert.equal(harness.state.writes.length, 1)
})

test('repeated or case-equivalent registration never changes an existing account including an administrator', () => {
  for (const role of ['1', '2']) {
    const existing = ['existing', 'NeW.Coach', 'original-hash', role, 'branch-1', 'Активен', '', '']
    const harness = createHarness({ Users: [REGISTRATION_HEADERS, existing] })
    assert.deepEqual(harness.request('registerCoach', registrationPayload()), { status: 'success', pending: true })
    assert.deepEqual(harness.sheets.get('Users').rows, [REGISTRATION_HEADERS, existing])
    assert.equal(harness.state.writes.length, 0)
  }
})

test('registration retry after an append committed but its acknowledgement was lost creates no duplicate', () => {
  const harness = createHarness({ Users: [REGISTRATION_HEADERS] })
  const sheet = harness.sheets.get('Users')
  const append = sheet.appendRow
  sheet.appendRow = (row) => {
    append(row)
    throw new Error('lost response after append')
  }
  assert.equal(harness.request('registerCoach', registrationPayload()).status, 'error')
  sheet.appendRow = append
  const differentlySaltedHash = REGISTRATION_HASH.replace(/b/g, 'c')
  assert.deepEqual(harness.request('registerCoach', registrationPayload({ passwordHash: differentlySaltedHash })), {
    status: 'success',
    pending: true,
  })
  assert.equal(sheet.rows.length, 2)
  assert.equal(sheet.rows[1][2], REGISTRATION_HASH)
})

test('pending coaches cannot authorize, even with forged active role or assigned-branch session claims', () => {
  const harness = createHarness({ Users: [REGISTRATION_HEADERS] }, { allowUnlockedReads: true })
  harness.request('registerCoach', registrationPayload())
  const id = harness.sheets.get('Users').rows[1][0]
  for (const action of ['getBootstrapData', 'getCurrentUser', 'recordBulkAttendance']) {
    assert.throws(
      () =>
        harness.canonicalRequireServerAuth({
          action,
          auth: { id, username: 'new.coach', role: 'admin', branchId: 'branch-1' },
        }),
      /Unauthorized/,
    )
  }
})

test('an administrator must assign a real branch before approving a self-registered coach', () => {
  const harness = createHarness({
    Users: [REGISTRATION_HEADERS],
    Филиалы: [
      ['id', 'name'],
      ['branch-1', 'Pool'],
    ],
  })
  harness.request('registerCoach', registrationPayload())
  const row = harness.sheets.get('Users').rows[1]
  const userId = row[0]
  assert.equal(harness.request('activateUser', { userId, requestId: 'approve-before-branch' }).code, 'FORBIDDEN')
  assert.equal(row[5], 'Ожидает подтверждения')
  assert.equal(
    harness.request('assignUserBranch', { userId, branchId: 'missing', requestId: 'invalid-branch' }).code,
    'NOT_FOUND',
  )
  assert.equal(
    harness.request('assignUserBranch', { userId, branchId: 'branch-1', requestId: 'assign-branch' }).success,
    true,
  )
  assert.equal(harness.sheets.get('Users').rows[1][5], 'Ожидает подтверждения')
  assert.equal(harness.request('activateUser', { userId, requestId: 'approve' }).success, true)
  assert.deepEqual(harness.sheets.get('Users').rows[1].slice(2, 6), [REGISTRATION_HASH, '2', 'branch-1', 'Активен'])
})

test('registration rejects malformed credentials, missing schema and unsigned GAS requests without writes', () => {
  for (const changes of [
    { username: 'bad<script>' },
    { username: 'ab' },
    { passwordHash: 'plain-password' },
    { requestId: '' },
  ]) {
    const harness = createHarness({ Users: [REGISTRATION_HEADERS] })
    assert.equal(harness.request('registerCoach', registrationPayload(changes)).status, 'error')
    assert.equal(harness.state.writes.length, 0)
  }
  const missingUsers = createHarness({})
  assert.equal(missingUsers.request('registerCoach', registrationPayload()).code, 'SCHEMA')
  assert.equal(missingUsers.sheets.size, 0)
  const unsigned = createHarness({ Users: [REGISTRATION_HEADERS] })
  unsigned.context.verifySignedEnvelope = () => unsigned.context.rejectUnauthorized('signature.hmac')
  assert.equal(unsigned.request('registerCoach', registrationPayload()).code, 'UNAUTHORIZED')
  assert.equal(unsigned.state.writes.length, 0)
  assert.equal(unsigned.state.acquisitions, 0)
})

test('schema migration is repeatable and preserves historical lesson balances', () => {
  const harness = createHarness({
    Users: [
      ['id', 'username', 'password', 'role', 'branchId'],
      ['admin-legacy', 'admin', 'legacy-hash', '1', ''],
    ],
    Тренеры: [
      ['id', 'name', 'specialty', 'branchId'],
      ['coach-1', 'Coach', 'Плавание', 'branch-1'],
    ],
    Клиенты: [
      ['id', 'branchId', 'lessonsPerWeek', 'totalLessons', 'remainingLessons'],
      ['client-1', 'branch-1', 3, 27, 19],
    ],
    Расписание: [
      ['id', 'branchId', 'dayOfWeek', 'time'],
      ['lesson-1', 'branch-1', 'Пт', '17:00'],
    ],
  })

  assert.equal(harness.context.setupSchema(), 'Schema 12 is ready')
  assert.equal(harness.context.setupSchema(), 'Schema 12 is ready')
  assert.equal(harness.properties.get('SCHEMA_VERSION'), '12')

  const clientRows = harness.sheets.get('Клиенты').rows
  const clientHeaders = clientRows[0]
  assert.equal(clientRows[1][clientHeaders.indexOf('totalLessons')], 27)
  assert.equal(clientRows[1][clientHeaders.indexOf('remainingLessons')], 19)
  assert.equal(clientRows[1][clientHeaders.indexOf('lessonsPerWeek')], 3)
  assert.equal(clientRows[1][clientHeaders.indexOf('category')], 'плавание')
  for (const header of ['totalLessons', 'remainingLessons', 'paid', 'purchasedAt', 'receiptUrl', 'attendanceHistory']) {
    assert.equal(clientHeaders.filter((candidate) => candidate === header).length, 1)
  }

  const userHeaders = harness.sheets.get('Users').rows[0]
  for (const header of ['status', 'disabledAt', 'disabledBy']) {
    assert.equal(userHeaders.filter((candidate) => candidate === header).length, 1)
  }
  assert.equal(harness.sheets.get('Users').rows[1][userHeaders.indexOf('status')], 'Активен')
  assert(harness.sheets.has('Посещения'))
  assert(harness.sheets.has('Платежи'))
  assert(harness.sheets.has('Журнал занятий'))
  assert(harness.sheets.has('Журнал администрирования'))
  assert.equal(harness.state.held, false)
})

test('the first administrator is created only by one-time bootstrap properties', () => {
  const harness = createHarness({
    Users: [['id', 'username', 'password', 'role', 'branchId', 'status', 'disabledAt', 'disabledBy']],
  })
  const passwordHash = 'scrypt$16384$8$1$abcdefghijklmnopqrstuv$' + 'a'.repeat(86)
  harness.properties.set('BOOTSTRAP_ADMIN_USERNAME', 'first-admin')
  harness.properties.set('BOOTSTRAP_ADMIN_PASSWORD_HASH', passwordHash)

  assert.equal(harness.context.setupInitialAdmin(), 'Администратор создан: first-admin')
  const users = harness.sheets.get('Users').rows
  assert.equal(users.length, 2)
  assert.equal(users[1][1], 'first-admin')
  assert.equal(users[1][2], passwordHash)
  assert.equal(users[1][3], '1')
  assert.equal(users[1][5], 'Активен')
  assert.equal(harness.properties.get('BOOTSTRAP_ADMIN_CREATED'), 'true')
  assert.equal(harness.properties.has('BOOTSTRAP_ADMIN_USERNAME'), false)
  assert.equal(harness.properties.has('BOOTSTRAP_ADMIN_PASSWORD_HASH'), false)

  harness.properties.set('BOOTSTRAP_ADMIN_USERNAME', 'attacker')
  harness.properties.set('BOOTSTRAP_ADMIN_PASSWORD_HASH', passwordHash)
  assert.throws(() => harness.context.setupInitialAdmin(), /Первый администратор уже создан/)
  assert.equal(users.length, 2)
  assert.equal(harness.state.held, false)
})

test('changing lessonsPerWeek does not rewrite paid lesson balance', () => {
  const harness = createHarness({
    Клиенты: [
      ['id', 'lessonsPerWeek', 'remainingLessons', 'totalLessons', 'status', 'branchId', 'note'],
      ['client-1', 1, 2, 4, 'Активен', 'branch-1', 'keep'],
      ['client-2', 2, 7, 8, 'Активен', 'branch-1', 'untouched'],
      ['client-empty', 1, 0, 0, 'Активен', 'branch-1', 'mistake'],
    ],
  })

  assert.deepEqual(harness.request('updateClient', { id: 'client-1', lessonsPerWeek: 3, requestId: 'client-plan-1' }), {
    success: true,
  })
  assert.equal(harness.state.acquisitions, 1)
  assert.deepEqual(harness.state.events.slice(-3), ['flush', 'invalidate', 'unlock'])
  const changed = harness.sheets.get('Клиенты').rows[1]
  assert.equal(changed[1], '3')
  assert.equal(changed[2], 2)
  assert.equal(changed[3], 4)
  assert.equal(changed[6], 'keep')

  const directBalanceEdit = harness.request('updateClient', {
    id: 'client-1',
    remainingLessons: 99,
    requestId: 'client-balance-bypass-1',
  })
  assert.equal(directBalanceEdit.status, 'error')
  assert.equal(directBalanceEdit.code, 'VALIDATION')
  assert.equal(directBalanceEdit.message, 'Проверьте введённые данные')
  assert.equal(harness.sheets.get('Клиенты').rows[1][2], 2)

  const usedClientDelete = harness.request('deleteClient', { id: 'client-1', requestId: 'delete-used-1' })
  assert.equal(usedClientDelete.status, 'error')
  assert.equal(usedClientDelete.code, 'CONFLICT')
  assert.deepEqual(harness.request('deleteClient', { id: 'client-empty', requestId: 'delete-empty-1' }), {
    success: true,
  })
  assert.equal(harness.state.acquisitions, 3)
  assert.equal(harness.sheets.get('Клиенты').rows.length, 3)
  assert.deepEqual(harness.state.events.slice(-3), ['flush', 'invalidate', 'unlock'])
})

test('only an unused client card can be deleted; payments, attendance and schedule links require archive', () => {
  const headers = [
    'id',
    'branchId',
    'assignedLessonIds',
    'remainingLessons',
    'totalLessons',
    'attendanceHistory',
    'paid',
    'paymentBalance',
    'receiptUrl',
    'paidAmount',
    'status',
  ]
  const harness = createHarness({
    Клиенты: [
      headers,
      ['empty', 'branch-1', '', 0, 0, '[]', false, 0, '', 0, 'Активен'],
      ['paid', 'branch-1', '', 0, 0, '[]', false, 0, '', 0, 'Активен'],
      [
        'attended',
        'branch-1',
        '',
        0,
        0,
        JSON.stringify([{ lessonId: 'lesson-1', date: '2026-10-02', status: 'attended' }]),
        false,
        0,
        '',
        0,
        'Архив',
      ],
      ['assigned', 'branch-1', 'lesson-1', 0, 0, '[]', false, 0, '', 0, 'Активен'],
      ['attendance-row', 'branch-1', '', 0, 0, '[]', false, 0, '', 0, 'Архив'],
    ],
    Платежи: [PAYMENT_HEADERS, ['payment-1', 'payment-request', 'paid']],
    'Журнал занятий': [LEDGER_HEADERS],
    Посещения: [
      ['id', 'requestId', 'lessonId', 'date', 'clientId'],
      ['attendance-1', 'attendance-request', 'lesson-1', '2026-10-02', 'attendance-row'],
    ],
  })

  for (const id of ['paid', 'attended', 'assigned', 'attendance-row']) {
    const result = harness.request('deleteClient', { id, requestId: 'delete-' + id })
    assert.equal(result.status, 'error')
    assert.equal(result.code, 'CONFLICT')
  }
  assert.deepEqual(harness.request('deleteClient', { id: 'empty', requestId: 'delete-empty' }), { success: true })
  assert.deepEqual(
    harness.sheets
      .get('Клиенты')
      .rows.slice(1)
      .map((row) => row[0]),
    ['paid', 'attended', 'assigned', 'attendance-row'],
  )
})

test('attendance writes only changed cells and creates a ledger movement', () => {
  const headers = [
    'id',
    'branchId',
    'assignedLessonIds',
    'remainingLessons',
    'totalLessons',
    'attendanceHistory',
    'status',
    'paid',
    'purchasedAt',
    'receiptUrl',
    'paymentBalance',
    'note',
  ]
  const client = (id, note) => [id, 'branch-1', 'lesson-1', 3, 4, '[]', 'Активен', true, '', '', 0, note]
  const ledgerRows = ['client-1', 'client-2', 'client-3'].flatMap((clientId) => [
    ledgerRow({
      id: clientId + '-grant',
      clientId,
      lessonsDelta: 4,
      totalLessonsDelta: 4,
      balanceAfter: 4,
      totalLessonsAfter: 4,
    }),
    ledgerRow({
      id: clientId + '-old-attendance',
      clientId,
      type: 'attendance',
      lessonsDelta: -1,
      balanceAfter: 3,
      totalLessonsAfter: 4,
    }),
  ])
  const harness = createHarness({
    Клиенты: [headers, client('client-1', 'first'), client('client-2', 'untouched'), client('client-3', 'third')],
    Платежи: [PAYMENT_HEADERS],
    'Журнал занятий': [LEDGER_HEADERS, ...ledgerRows],
    Расписание: [
      ['id', 'branchId', 'date', 'dayOfWeek', 'time', 'category', 'isRecurring'],
      ['lesson-1', 'branch-1', '2026-10-02', 'Пт', '17:00', 'плавание', false],
    ],
  })

  const result = harness.request('recordBulkAttendance', {
    requestId: 'attendance-1',
    attendance: [
      { clientId: 'client-1', lessonId: 'lesson-1', date: '2026-10-02', status: 'attended' },
      { clientId: 'client-3', lessonId: 'lesson-1', date: '2026-10-02', status: 'absent' },
    ],
  })

  assert.equal(result.success, true)
  assert.equal(harness.state.acquisitions, 1)
  assert.deepEqual(harness.state.events.slice(-3), ['flush', 'invalidate', 'unlock'])
  const rows = harness.sheets.get('Клиенты').rows
  assert.equal(rows[1][3], 2)
  assert.equal(rows[2][3], 3)
  assert.equal(rows[3][3], 3)
  assert.equal(rows[2][5], '[]')
  assert.equal(rows[2][11], 'untouched')
  const clientWrites = harness.state.writes.filter((write) => write.name === 'Клиенты')
  assert.equal(clientWrites.length, 6)
  assert(
    clientWrites.every((write) => [2, 4].includes(write.row) && [4, 6, 7].includes(write.column) && write.width === 1),
  )
  const ledger = harness.sheets.get('Журнал занятий').rows
  assert.equal(ledger.length, 9)
  const added = ledger[7]
  assert.equal(added[LEDGER_HEADERS.indexOf('type')], 'attendance')
  assert.equal(added[LEDGER_HEADERS.indexOf('lessonsDelta')], -1)
  assert.equal(added[LEDGER_HEADERS.indexOf('balanceAfter')], 2)
  assert.equal(added[LEDGER_HEADERS.indexOf('recordedBy')], 'admin')
  assert.equal(ledger[8][LEDGER_HEADERS.indexOf('type')], 'attendance_confirmation')
  assert.equal(ledger[8][LEDGER_HEADERS.indexOf('lessonsDelta')], 0)
})

function resilienceAttendanceHarness(options = {}) {
  const headers = [
    'id',
    'branchId',
    'assignedLessonIds',
    'remainingLessons',
    'totalLessons',
    'attendanceHistory',
    'status',
    'paid',
    'purchasedAt',
    'receiptUrl',
    'paymentBalance',
  ]
  return createHarness(
    {
      Клиенты: [headers, ['client-1', 'branch-1', 'lesson-1', 2, 2, '[]', 'Активен', true, '2026-10-01', '', 0]],
      Платежи: [PAYMENT_HEADERS],
      'Журнал занятий': [
        LEDGER_HEADERS,
        ledgerRow({
          clientId: 'client-1',
          lessonsDelta: 2,
          totalLessonsDelta: 2,
          balanceAfter: 2,
          totalLessonsAfter: 2,
        }),
      ],
      Расписание: [
        ['id', 'branchId', 'date', 'dayOfWeek', 'time', 'category', 'isRecurring'],
        ['lesson-1', 'branch-1', '2026-10-04', 'Вс', '17:00', 'плавание', false],
      ],
    },
    options,
  )
}

test('coach bootstrap skips coach sheet reads without dropping canonical branch checks', () => {
  const harness = createHarness(
    {
      Филиалы: [
        ['id', 'name'],
        ['branch-1', 'Pool'],
        ['branch-2', 'Other'],
      ],
      Расписание: [
        ['id', 'title', 'branchId'],
        ['lesson-1', 'Swimming', 'branch-1'],
        ['other', 'Other', 'branch-2'],
      ],
      // No coach sheet: the coach workflow must not depend on it.
    },
    { allowUnlockedReads: true },
  )
  harness.context.requireServerAuth = () => ({ id: 'coach-1', username: 'coach', role: 'coach', branchId: 'branch-1' })
  const result = harness.request('getBootstrapData', { includeCoaches: false, branchId: 'branch-2' })
  assert.deepEqual(result.coaches, [])
  assert.deepEqual(
    result.branches.map((row) => row.id),
    ['branch-1'],
  )
  assert.deepEqual(
    result.lessons.map((row) => row.id),
    ['lesson-1'],
  )
  assert.deepEqual(
    harness.state.events.filter((event) => event.startsWith('read:')),
    ['read:Филиалы', 'read:Расписание'],
  )
  assert.equal(harness.request('getBootstrapData', { includeCoaches: 'false' }).code, 'VALIDATION')
})

test('session and bootstrap each check Users and a mutation rejects a newly disabled account', () => {
  const harness = createHarness(
    {
      Users: [
        ['id', 'username', 'password', 'role', 'branchId', 'status', 'disabledAt', 'disabledBy'],
        ['coach-1', 'coach', 'hash', '2', 'branch-1', 'Активен', '', ''],
      ],
    },
    { allowUnlockedReads: true },
  )
  vm.runInContext(gas, harness.context) // Restore the real auth implementation rather than the transaction stub.
  const auth = { id: 'coach-1', username: 'coach', role: 'coach', branchId: 'branch-1' }
  const probe = harness.context.requireServerAuth({ action: 'getCurrentUser', auth })
  const bootstrap = harness.context.requireServerAuth({ action: 'getBootstrapData', auth })
  assert.equal(bootstrap.id, probe.id)
  assert.equal(harness.state.events.filter((event) => event === 'read:Users').length, 2)
  harness.sheets.get('Users').rows[1][5] = 'Отключен'
  assert.throws(
    () => harness.context.requireServerAuth({ action: 'recordBulkAttendance', auth }),
    (error) => error.apiCode === 'UNAUTHORIZED',
  )
  assert.equal(harness.state.events.filter((event) => event === 'read:Users').length, 3)
})

test('opening roster reads each sheet once and retains all pupils', () => {
  const harness = resilienceAttendanceHarness({ allowUnlockedReads: true })
  const clients = harness.sheets.get('Клиенты')
  clients.rows[0].push('childName', 'parentName', 'category')
  clients.rows[1].push('Child', 'Parent', 'плавание')
  const result = harness.context.getLessonRoster(
    harness.context.SpreadsheetApp.getActiveSpreadsheet(),
    { lessonId: 'lesson-1', date: '2026-10-04' },
    { role: 'admin' },
  )
  assert.equal(result.clients.length, 1)
  assert.deepEqual(
    harness.state.events.filter((event) => event.startsWith('read:')),
    ['read:Расписание', 'read:Клиенты'],
  )
})

test('a 100-pupil attendance chunk partitions a large ledger once and batches writes', () => {
  const harness = resilienceAttendanceHarness()
  const clients = harness.sheets.get('Клиенты')
  const ledger = harness.sheets.get('Журнал занятий')
  for (let i = 2; i <= 2000; i++) {
    clients.rows.push([`client-${i}`, 'branch-1', 'lesson-1', 2, 2, '[]', 'Активен', true, '2026-10-01', '', 0])
    ledger.rows.push(
      ledgerRow({
        clientId: `client-${i}`,
        lessonsDelta: 2,
        totalLessonsDelta: 2,
        balanceAfter: 2,
        totalLessonsAfter: 2,
      }),
    )
  }
  const stateForClient = harness.context.calculateLessonLedgerState
  const checkPayments = harness.context.reconcilePaymentsWithLedger
  let examinedLedgerRows = 0
  harness.context.calculateLessonLedgerState = (parsed, id) => {
    assert.equal(parsed.rows.length, 1, 'do not rescan unrelated clients')
    examinedLedgerRows += parsed.rows.length
    return stateForClient(parsed, id)
  }
  harness.context.reconcilePaymentsWithLedger = (payments, parsed, id) => {
    assert.equal(parsed.rows.length, 1)
    examinedLedgerRows += parsed.rows.length
    return checkPayments(payments, parsed, id)
  }
  const result = harness.request('recordBulkAttendance', {
    requestId: 'large-group',
    attendance: Array.from({ length: 100 }, (_, i) => ({
      clientId: `client-${i + 1}`,
      lessonId: 'lesson-1',
      date: '2026-10-04',
      status: 'attended',
    })),
  })
  assert.equal(result.success, true)
  assert.equal(result.results.length, 100)
  assert.equal(examinedLedgerRows, 200) // One ledger calculation and payment check per client.
  assert.deepEqual(
    harness.state.events.filter((event) => event.startsWith('read:')),
    ['read:Расписание', 'read:Клиенты', 'read:Журнал занятий', 'read:Платежи'],
  )
  assert.equal(harness.state.writes.length, 4) // Three contiguous client columns + one ledger range.
  assert.equal(clients.rows[100][3], 1)
  assert.equal(clients.rows[101][3], 2)
  assert.equal(ledger.rows.length, 2101)
})

test('partitioned accounting preserves physical audit row numbers and handles special IDs', () => {
  const harness = resilienceAttendanceHarness()
  const parsed = {
    headers: LEDGER_HEADERS,
    rows: [ledgerRow({ clientId: 'other' }), ledgerRow({ clientId: '__proto__', balanceBefore: 7, balanceAfter: 0 })],
  }
  const grouped = harness.context.accountingRowsByClient(parsed)
  assert.equal(grouped['__proto__'].rows.length, 1)
  const selected = Object.create(null)
  selected['__proto__'] = true
  const limited = harness.context.accountingRowsByClient(parsed, selected)
  assert.equal(limited.other, undefined, 'index memory only contains the selected pupils')
  assert.equal(limited['__proto__'].sourceRowIndices[0], 1)
  const full = harness.context.calculateLessonLedgerState(parsed, '__proto__')
  const partitioned = harness.context.calculateLessonLedgerState(grouped['__proto__'], '__proto__')
  assert.equal(JSON.stringify(partitioned), JSON.stringify(full))
  assert.match(partitioned.issues[0], /Строка журнала 3/)
})

test('duplicate items within a chunk use the staged persistent request index without double spending', () => {
  const harness = resilienceAttendanceHarness()
  const item = { clientId: 'client-1', lessonId: 'lesson-1', date: '2026-10-04', status: 'attended' }
  const result = harness.request('recordBulkAttendance', { requestId: 'duplicate-chunk', attendance: [item, item] })
  assert.equal(result.success, true)
  assert.equal(result.results[1].duplicate, true)
  assert.equal(harness.sheets.get('Клиенты').rows[1][3], 1)
  assert.equal(harness.sheets.get('Журнал занятий').rows.length, 3)
})

test('attendance rolls back a failure between client-column writes', () => {
  const harness = resilienceAttendanceHarness()
  const sheet = harness.sheets.get('Клиенты')
  const before = sheet.rows[1].slice()
  const getRange = sheet.getRange
  let failOnce = true
  sheet.getRange = (...args) => {
    const range = getRange(...args)
    const setValues = range.setValues
    range.setValues = (values) => {
      if (args[0] === 2 && args[1] === 6 && failOnce) {
        failOnce = false
        throw new Error('simulated write failure')
      }
      setValues(values)
    }
    return range
  }
  const result = harness.request('recordAttendance', {
    clientId: 'client-1',
    lessonId: 'lesson-1',
    date: '2026-10-04',
    status: 'attended',
    requestId: 'failed-column',
  })
  assert.equal(result.status, 'error')
  assert.deepEqual(sheet.rows[1], before)
  assert.equal(harness.sheets.get('Журнал занятий').rows.length, 2)
  assert.equal(harness.state.held, false)
})

test('a ledger write that commits then throws retains planned rows for rollback', () => {
  const harness = resilienceAttendanceHarness()
  const clients = harness.sheets.get('Клиенты')
  const before = clients.rows[1].slice()
  const ledger = harness.sheets.get('Журнал занятий')
  const getRange = ledger.getRange
  ledger.getRange = (...args) => {
    const range = getRange(...args)
    const setValues = range.setValues
    range.setValues = (values) => {
      setValues(values)
      throw new Error('simulated lost acknowledgement')
    }
    return range
  }
  const result = harness.request('recordAttendance', {
    clientId: 'client-1',
    lessonId: 'lesson-1',
    date: '2026-10-04',
    status: 'attended',
    requestId: 'failed-ledger',
  })
  assert.equal(result.status, 'error')
  assert.deepEqual(clients.rows[1], before)
  assert.equal(ledger.rows.length, 2)
  assert.equal(harness.state.held, false)
})

function atomicAttendanceHarness({ failBefore = false, loseAcknowledgement = false } = {}) {
  const harness = resilienceAttendanceHarness()
  harness.properties.set('ATTENDANCE_ATOMIC_WRITES', 'true')
  const batches = []
  harness.atomicBatches = batches
  harness.context.Sheets = {
    Spreadsheets: {
      batchUpdate(body, spreadsheetId) {
        assert.equal(harness.state.held, true)
        assert.equal(spreadsheetId, 'test-spreadsheet')
        batches.push(body)
        if (failBefore) throw new Error('simulated API rejection')
        const staged = new Map(
          [...harness.sheets.values()].map((sheet) => [sheet, sheet.rows.map((row) => row.slice())]),
        )
        const decode = (cell) => {
          assert.deepEqual(Object.keys(cell), ['userEnteredValue'])
          const value = cell.userEnteredValue
          assert.equal(Object.keys(value).length, 1)
          assert.equal('formulaValue' in value, false)
          return Object.values(value)[0]
        }
        // The fake API stages every request before committing any sheet.
        for (const request of body.requests) {
          const operation = request.updateCells || request.appendCells
          assert.equal(operation.fields, 'userEnteredValue')
          const id = operation.range?.sheetId ?? operation.sheetId
          const sheet = [...harness.sheets.values()].find((item) => item.getSheetId() === id)
          assert.ok(sheet)
          const rows = staged.get(sheet)
          if (request.updateCells) {
            const range = operation.range
            assert.equal(range.endColumnIndex - range.startColumnIndex, 1)
            assert.equal(range.endRowIndex - range.startRowIndex, operation.rows.length)
            operation.rows.forEach((row, offset) => {
              assert.ok(rows[range.startRowIndex + offset])
              rows[range.startRowIndex + offset][range.startColumnIndex] = decode(row.values[0])
            })
          } else {
            rows.push(...operation.rows.map((row) => row.values.map(decode)))
          }
        }
        for (const [sheet, rows] of staged) sheet.rows.splice(0, sheet.rows.length, ...rows)
        harness.state.writes.push({ atomic: true })
        if (loseAcknowledgement) {
          loseAcknowledgement = false
          throw new Error('simulated lost API acknowledgement')
        }
        return { spreadsheetId }
      },
    },
  }
  return harness
}

const atomicMark = (requestId, status = 'attended') => ({
  clientId: 'client-1',
  lessonId: 'lesson-1',
  date: '2026-10-04',
  status,
  requestId,
})

test('atomic attendance commits changed cells and ledger in one API call and returns balances', () => {
  const harness = atomicAttendanceHarness()
  const before = harness.sheets.get('Клиенты').rows[1].slice()
  const response = harness.request('recordAttendance', atomicMark('atomic-save'))
  assert.equal(response.success, true)
  assert.deepEqual(response.results[0].client, { remainingLessons: 1, totalLessons: 2, status: 'Активен' })
  assert.equal(harness.atomicBatches.length, 1)
  assert.equal(harness.state.writes.length, 1)
  const after = harness.sheets.get('Клиенты').rows[1]
  assert.deepEqual(after.slice(0, 3), before.slice(0, 3))
  assert.deepEqual(after.slice(7), before.slice(7))
  assert.equal(harness.sheets.get('Журнал занятий').rows.length, 3)
  const repeat = harness.request('recordAttendance', atomicMark('atomic-save'))
  assert.equal(repeat.results[0].duplicate, true)
  assert.equal(repeat.results[0].client.remainingLessons, 1)
  assert.equal(harness.atomicBatches.length, 1, 'a duplicate issues no new commit')
})

test('atomic API rejection leaves both sheets unchanged and never uses the legacy writer', () => {
  const harness = atomicAttendanceHarness({ failBefore: true })
  const before = JSON.stringify([...harness.sheets].map(([name, sheet]) => [name, sheet.rows]))
  const response = harness.request('recordAttendance', atomicMark('atomic-rejected'))
  assert.equal(response.code, 'SCHEMA')
  assert.equal(JSON.stringify([...harness.sheets].map(([name, sheet]) => [name, sheet.rows])), before)
  assert.equal(harness.state.writes.length, 0)
  assert.equal(harness.atomicBatches.length, 1)
  assert.equal(harness.state.held, false)
})

test('a lost atomic acknowledgement preserves committed data and retry never spends twice', () => {
  const harness = atomicAttendanceHarness({ loseAcknowledgement: true })
  assert.equal(harness.request('recordAttendance', atomicMark('lost-ack')).code, 'SCHEMA')
  assert.equal(harness.sheets.get('Клиенты').rows[1][3], 1)
  assert.equal(harness.sheets.get('Журнал занятий').rows.length, 3)
  const retried = harness.request('recordAttendance', atomicMark('lost-ack'))
  assert.equal(retried.success, true)
  assert.equal(retried.results[0].duplicate, true)
  assert.equal(retried.results[0].client.remainingLessons, 1)
  assert.equal(harness.atomicBatches.length, 1)
  assert.equal(harness.state.held, false)
})

test('an empty atomic API reply is not reported as success and retry recognizes the committed marker', () => {
  const harness = atomicAttendanceHarness()
  const commit = harness.context.Sheets.Spreadsheets.batchUpdate
  harness.context.Sheets.Spreadsheets.batchUpdate = (...args) => {
    commit(...args)
    return undefined
  }
  assert.equal(harness.request('recordAttendance', atomicMark('empty-api-reply')).code, 'SCHEMA')
  const retried = harness.request('recordAttendance', atomicMark('empty-api-reply'))
  assert.equal(retried.success, true)
  assert.equal(retried.results[0].duplicate, true)
  assert.equal(retried.results[0].client.remainingLessons, 1)
  assert.equal(harness.atomicBatches.length, 1)
})

test('atomic attendance batches 100 pupils and preserves unrelated cells', () => {
  const harness = atomicAttendanceHarness()
  const clients = harness.sheets.get('Клиенты')
  const ledger = harness.sheets.get('Журнал занятий')
  for (let index = 2; index <= 100; index++) {
    clients.rows.push([`client-${index}`, 'branch-1', 'lesson-1', 2, 2, '[]', 'Активен', true, '2026-10-01', '', 0])
    ledger.rows.push(
      ledgerRow({
        clientId: `client-${index}`,
        lessonsDelta: 2,
        totalLessonsDelta: 2,
        balanceAfter: 2,
        totalLessonsAfter: 2,
      }),
    )
  }
  const result = harness.request('recordBulkAttendance', {
    requestId: 'atomic-100',
    attendance: Array.from({ length: 100 }, (_, index) => ({
      ...atomicMark('unused'),
      clientId: `client-${index + 1}`,
    })),
  })
  assert.equal(result.success, true)
  assert.equal(result.results.length, 100)
  assert.ok(result.results.every((item) => item.client.remainingLessons === 1))
  assert.equal(harness.atomicBatches.length, 1)
  assert.equal(harness.atomicBatches[0].requests.length, 4, 'three changed-column ranges and one journal append')
  assert.ok(clients.rows.slice(1).every((row) => row[2] === 'lesson-1' && row[4] === 2 && row[7] === true))
  assert.equal(ledger.rows.length, 201)
})

test('atomic mode without the Advanced Sheets service fails before touching any row', () => {
  const harness = resilienceAttendanceHarness()
  harness.properties.set('ATTENDANCE_ATOMIC_WRITES', 'true')
  const response = harness.request('recordAttendance', atomicMark('missing-service'))
  assert.equal(response.code, 'SCHEMA')
  assert.equal(harness.state.writes.length, 0)
  assert.equal(harness.sheets.get('Клиенты').rows[1][3], 2)
})

test('atomic group validation rejects an invalid pupil before issuing any API call', () => {
  const harness = atomicAttendanceHarness()
  const response = harness.request('recordBulkAttendance', {
    requestId: 'invalid-group',
    attendance: [atomicMark('unused'), { ...atomicMark('unused'), clientId: 'missing' }],
  })
  assert.equal(response.success, false)
  assert.equal(harness.atomicBatches.length, 0)
  assert.equal(harness.state.writes.length, 0)
})

test('attendance retry returns current balances after a later correction, even while response cache is warm', () => {
  for (const harness of [resilienceAttendanceHarness(), atomicAttendanceHarness()]) {
    const first = harness.request('recordAttendance', atomicMark('original'))
    assert.equal(first.results[0].client.remainingLessons, 1)
    assert.equal(harness.request('recordAttendance', atomicMark('correction', 'absent')).success, true)
    const writes = harness.state.writes.length
    const retry = harness.request('recordAttendance', atomicMark('original'))
    assert.equal(retry.results[0].duplicate, true)
    assert.deepEqual(retry.results[0].client, { remainingLessons: 2, totalLessons: 2, status: 'Активен' })
    assert.equal(harness.state.writes.length, writes)
  }
})

test('expired attendance retries never undo a later correction, including absence requests', () => {
  const harness = resilienceAttendanceHarness()
  const mark = (status, requestId) =>
    harness.request('recordAttendance', {
      clientId: 'client-1',
      lessonId: 'lesson-1',
      date: '2026-10-04',
      status,
      requestId,
    })
  assert.equal(mark('absent', 'absent-first').success, true)
  assert.equal(mark('attended', 'attended-next').success, true)
  harness.cacheValues.clear()
  assert.equal(mark('absent', 'absent-first').results[0].duplicate, true)
  assert.equal(harness.sheets.get('Клиенты').rows[1][3], 1)
  assert.equal(JSON.parse(harness.sheets.get('Клиенты').rows[1][5])[0].status, 'attended')
  assert.equal(mark('absent', 'absent-correction').success, true)
  harness.cacheValues.clear()
  const writes = harness.state.writes.length
  assert.equal(mark('attended', 'attended-next').results[0].duplicate, true)
  assert.equal(harness.state.writes.length, writes)
  assert.equal(harness.sheets.get('Клиенты').rows[1][3], 2)
  assert.equal(JSON.parse(harness.sheets.get('Клиенты').rows[1][5])[0].status, 'absent')
  harness.cacheValues.clear()
  assert.equal(mark('attended', 'absent-first').code, 'CONFLICT')
})

test('blank purchasedAt does not auto-accept changes to an already journalled balance', () => {
  const harness = resilienceAttendanceHarness()
  const clients = harness.sheets.get('Клиенты')
  clients.rows[1][8] = ''
  clients.rows[1][3] = 3
  clients.rows[1][4] = 4
  const result = harness.request('recordAttendance', {
    clientId: 'client-1',
    lessonId: 'lesson-1',
    date: '2026-10-04',
    status: 'attended',
    requestId: 'manual-change',
  })
  assert.equal(result.code, 'CONFLICT')
  assert.equal(harness.state.writes.length, 0)
  assert.equal(harness.sheets.get('Журнал занятий').rows.length, 2)
})

test('coach attendance still rejects a lesson from another branch without writing anything', () => {
  const harness = resilienceAttendanceHarness()
  harness.context.requireServerAuth = () => ({ id: 'coach-1', username: 'coach', role: 'coach', branchId: 'branch-2' })
  const result = harness.request('recordAttendance', {
    clientId: 'client-1',
    lessonId: 'lesson-1',
    date: '2026-10-04',
    status: 'attended',
    requestId: 'wrong-branch',
  })
  assert.equal(result.code, 'FORBIDDEN')
  assert.equal(harness.state.writes.length, 0)
})

test('first attendance on a legacy card establishes its opening ledger balance without changing it first', () => {
  const clientHeaders = [
    'id',
    'branchId',
    'category',
    'remainingLessons',
    'totalLessons',
    'attendanceHistory',
    'status',
    'paid',
    'purchasedAt',
    'receiptUrl',
    'paymentBalance',
    'assignedLessonIds',
  ]
  const harness = createHarness({
    Клиенты: [clientHeaders, ['legacy-client', 'branch-1', '', 3, 4, '[]', 'Активен', false, '', '', 0, '']],
    Платежи: [PAYMENT_HEADERS],
    'Журнал занятий': [LEDGER_HEADERS],
    Расписание: [
      ['id', 'branchId', 'date', 'dayOfWeek', 'time', 'category', 'isRecurring'],
      ['lesson-1', 'branch-1', '2026-10-04', 'Вс', '17:00', 'плавание', false],
    ],
  })

  const result = harness.request('recordAttendance', {
    clientId: 'legacy-client',
    lessonId: 'lesson-1',
    date: '2026-10-04',
    status: 'attended',
    requestId: 'legacy-first-attendance',
  })

  assert.equal(result.success, true)
  assert.equal(harness.sheets.get('Клиенты').rows[1][clientHeaders.indexOf('remainingLessons')], 2)
  const ledgerRows = harness.sheets.get('Журнал занятий').rows
  assert.equal(ledgerRows.length, 3)
  assert.equal(ledgerRows[1][LEDGER_HEADERS.indexOf('type')], 'legacy_opening_balance')
  assert.equal(ledgerRows[1][LEDGER_HEADERS.indexOf('balanceAfter')], 3)
  assert.equal(ledgerRows[1][LEDGER_HEADERS.indexOf('totalLessonsAfter')], 4)
  assert.equal(ledgerRows[2][LEDGER_HEADERS.indexOf('type')], 'attendance')
  assert.equal(ledgerRows[2][LEDGER_HEADERS.indexOf('balanceAfter')], 2)
  const ledgerWrites = harness.state.writes.filter((write) => write.name === 'Журнал занятий')
  assert.equal(ledgerWrites.length, 1)
  assert.equal(ledgerWrites[0].height, 2)
})

test('first attendance restores a confirmed legacy payment that is missing from the ledger', () => {
  const clientHeaders = [
    'id',
    'branchId',
    'category',
    'remainingLessons',
    'totalLessons',
    'attendanceHistory',
    'status',
    'paid',
    'purchasedAt',
    'receiptUrl',
    'paymentBalance',
    'assignedLessonIds',
  ]
  const payment = PAYMENT_HEADERS.map((header) => {
    if (header === 'id') return 'legacy-payment-1'
    if (header === 'requestId') return 'legacy-payment-request'
    if (header === 'clientId') return 'paid-client'
    if (header === 'branchId') return 'branch-1'
    if (header === 'amount') return 8000
    if (header === 'category') return 'плавание'
    if (header === 'lessonsPerWeek') return 2
    if (header === 'lessonsAdded') return 8
    return ''
  })
  const harness = createHarness({
    Клиенты: [
      clientHeaders,
      ['paid-client', 'branch-1', 'плавание', 8, 8, '[]', 'Активен', true, '2026-09-27T09:33:31.754Z', '', 0, ''],
    ],
    Платежи: [PAYMENT_HEADERS, payment],
    'Журнал занятий': [LEDGER_HEADERS],
    Расписание: [
      ['id', 'branchId', 'date', 'dayOfWeek', 'time', 'category', 'isRecurring'],
      ['lesson-1', 'branch-1', '2026-10-04', 'Вс', '17:00', 'плавание', false],
    ],
  })

  const result = harness.request('recordAttendance', {
    clientId: 'paid-client',
    lessonId: 'lesson-1',
    date: '2026-10-04',
    status: 'attended',
    requestId: 'paid-client-first-attendance',
  })

  assert.equal(result.success, true)
  assert.equal(harness.sheets.get('Клиенты').rows[1][clientHeaders.indexOf('remainingLessons')], 7)
  const ledgerRows = harness.sheets.get('Журнал занятий').rows
  assert.equal(ledgerRows[1][LEDGER_HEADERS.indexOf('type')], 'purchase_repair')
  assert.equal(ledgerRows[1][LEDGER_HEADERS.indexOf('paymentId')], 'legacy-payment-1')
  assert.equal(ledgerRows[2][LEDGER_HEADERS.indexOf('type')], 'attendance')
})

test('bulk attendance writes no client marks when any selected client fails validation', () => {
  const headers = [
    'id',
    'branchId',
    'category',
    'remainingLessons',
    'totalLessons',
    'attendanceHistory',
    'status',
    'paid',
    'purchasedAt',
    'receiptUrl',
    'paymentBalance',
    'assignedLessonIds',
  ]
  const harness = createHarness({
    Клиенты: [
      headers,
      ['swimmer', 'branch-1', 'плавание', 1, 1, '[]', 'Активен', true, '', '', 0, ''],
      ['synchronized', 'branch-1', 'синхронное плавание', 1, 1, '[]', 'Активен', true, '', '', 0, ''],
    ],
    Платежи: [PAYMENT_HEADERS],
    'Журнал занятий': [
      LEDGER_HEADERS,
      ledgerRow({
        id: 'swimmer-opening',
        clientId: 'swimmer',
        lessonsDelta: 1,
        totalLessonsDelta: 1,
        balanceAfter: 1,
        totalLessonsAfter: 1,
      }),
      ledgerRow({
        id: 'synchronized-opening',
        clientId: 'synchronized',
        lessonsDelta: 1,
        totalLessonsDelta: 1,
        balanceAfter: 1,
        totalLessonsAfter: 1,
      }),
    ],
    Расписание: [
      ['id', 'branchId', 'date', 'dayOfWeek', 'time', 'category', 'isRecurring'],
      ['lesson-1', 'branch-1', '2026-10-04', 'Вс', '17:00', 'плавание', false],
    ],
  })

  const result = harness.request('recordBulkAttendance', {
    requestId: 'atomic-attendance',
    attendance: [
      { clientId: 'swimmer', lessonId: 'lesson-1', date: '2026-10-04', status: 'attended' },
      { clientId: 'synchronized', lessonId: 'lesson-1', date: '2026-10-04', status: 'attended' },
    ],
  })

  assert.equal(result.success, false)
  assert.equal(result.code, 'CONFLICT')
  assert.equal(harness.sheets.get('Клиенты').rows[1][headers.indexOf('remainingLessons')], 1)
  assert.equal(harness.sheets.get('Клиенты').rows[1][headers.indexOf('attendanceHistory')], '[]')
  assert.equal(harness.sheets.get('Журнал занятий').rows.length, 3)
})

test('mutation errors release the lock without writing client rows', () => {
  const harness = createHarness({
    Клиенты: [
      ['id', 'lessonsPerWeek', 'remainingLessons', 'totalLessons', 'status'],
      ['client-1', 1, 2, 4, 'Активен'],
    ],
  })
  const result = harness.request('updateClient', { id: 'missing', lessonsPerWeek: 2, requestId: 'missing-1' })
  assert.equal(result.status, 'error')
  assert.equal(harness.state.held, false)
  assert.deepEqual(harness.state.events.slice(-3), ['flush', 'invalidate', 'unlock'])
  assert.equal(harness.state.writes.length, 0)
})

test('client creation and its initial payment use one lock', () => {
  const clientHeaders = [
    'id',
    'childName',
    'parentName',
    'branchId',
    'category',
    'lessonsPerWeek',
    'paidAmount',
    'totalLessons',
    'remainingLessons',
    'paid',
    'paymentBalance',
    'purchasedAt',
    'receiptUrl',
    'attendanceHistory',
    'status',
    'assignedLessonIds',
  ]
  const harness = createHarness({
    Клиенты: [clientHeaders],
    Филиалы: [
      ['id', 'name', 'address'],
      ['branch-1', 'Pool', 'Street'],
    ],
    Платежи: [PAYMENT_HEADERS],
    'Журнал занятий': [LEDGER_HEADERS],
  })
  const created = harness.request('createClient', {
    childName: 'Child',
    parentName: 'Parent',
    branchId: 'branch-1',
    category: 'плавание',
    lessonsPerWeek: 1,
    paidAmount: 5500,
    requestId: 'create-paid-1',
  })

  assert.equal(created.totalLessons, 4)
  assert.equal(created.remainingLessons, 4)
  assert.equal(harness.state.acquisitions, 1)
  assert.deepEqual(harness.state.events.slice(-3), ['flush', 'invalidate', 'unlock'])
  assert.equal(harness.sheets.get('Клиенты').rows.length, 2)
  assert.equal(harness.sheets.get('Платежи').rows.length, 2)
  assert.equal(harness.sheets.get('Журнал занятий').rows.length, 2)
})
test('attendance refuses an unmigrated client sheet without changing it', () => {
  const harness = createHarness({
    Клиенты: [
      ['id', 'branchId', 'assignedLessonIds', 'remainingLessons', 'totalLessons', 'attendanceHistory', 'status'],
      ['client-1', 'branch-1', 'lesson-1', 3, 4, '[]', 'Активен'],
    ],
    Расписание: [
      ['id', 'branchId', 'date', 'dayOfWeek', 'time', 'category', 'isRecurring'],
      ['lesson-1', 'branch-1', '2026-10-02', 'Пт', '17:00', 'плавание', false],
    ],
  })
  const result = harness.request('recordAttendance', {
    clientId: 'client-1',
    lessonId: 'lesson-1',
    date: '2026-10-02',
    status: 'attended',
    requestId: 'missing-schema-1',
  })

  assert.equal(result.status, 'error')
  assert.equal(result.code, 'SCHEMA')
  assert.doesNotMatch(result.message, /setupSchema|схем/i)
  assert.equal(harness.state.writes.length, 0)
  assert.equal(harness.state.held, false)
})
test('payment requestId remains idempotent after response cache expires', () => {
  const clientHeaders = [
    'id',
    'branchId',
    'category',
    'lessonsPerWeek',
    'paidAmount',
    'totalLessons',
    'remainingLessons',
    'paid',
    'paymentBalance',
    'status',
    'purchasedAt',
    'receiptUrl',
    'attendanceHistory',
    'assignedLessonIds',
  ]
  const harness = createHarness({
    Клиенты: [clientHeaders, ['client-1', 'branch-1', 'плавание', 1, 0, 0, 0, false, 0, 'Пауза', '', '', '[]']],
    Платежи: [PAYMENT_HEADERS],
    'Журнал занятий': [LEDGER_HEADERS],
  })
  const payload = {
    clientId: 'client-1',
    amount: 5500,
    category: 'плавание',
    lessonsPerWeek: 1,
    comment: 'October',
    requestId: 'pay-1',
  }
  const first = harness.request('recordPayment', payload)
  assert.equal(first.success, true)
  assert.equal(harness.sheets.get('Платежи').rows.length, 2)
  assert.equal(harness.sheets.get('Журнал занятий').rows.length, 2)
  const events = harness.state.events
  assert(events.indexOf('flush') < events.indexOf('invalidate'), 'read cache invalidation follows flush')

  harness.cacheValues.clear()
  const duplicate = harness.request('recordPayment', payload)
  assert.equal(duplicate.success, true)
  assert.equal(duplicate.duplicate, true)
  assert.equal(harness.sheets.get('Платежи').rows.length, 2)
  assert.equal(harness.sheets.get('Журнал занятий').rows.length, 2)
  assert.equal(harness.sheets.get('Клиенты').rows[1][6], 4)

  harness.cacheValues.clear()
  const changed = harness.request('recordPayment', { ...payload, amount: 11000 })
  assert.equal(changed.status, 'error')
  assert.equal(changed.code, 'CONFLICT')
  assert.equal(harness.sheets.get('Платежи').rows.length, 2)
})

test('only journalled adjustments can change credits, and audit repairs legacy discrepancies', () => {
  const headers = [
    'id',
    'branchId',
    'category',
    'lessonsPerWeek',
    'paidAmount',
    'totalLessons',
    'remainingLessons',
    'paid',
    'paymentBalance',
    'status',
    'purchasedAt',
    'receiptUrl',
    'attendanceHistory',
    'assignedLessonIds',
  ]
  const harness = createHarness(
    {
      Клиенты: [
        headers,
        ['client-1', 'branch-1', 'плавание', 1, 5500, 4, 3, true, 0, 'Активен', '', '', '[]'],
        ['client-2', 'branch-1', 'плавание', 1, 5500, 4, 3, true, 0, 'Активен', '', '', '[]'],
      ],
      Платежи: [
        PAYMENT_HEADERS,
        [
          'payment-2',
          'legacy-payment',
          'client-2',
          'branch-1',
          5500,
          'плавание',
          1,
          5500,
          4,
          1,
          4,
          '2026-09-01',
          'admin',
          '',
          'legacy',
        ],
      ],
      'Журнал занятий': [
        LEDGER_HEADERS,
        ledgerRow({
          id: 'client-1-grant',
          clientId: 'client-1',
          lessonsDelta: 4,
          totalLessonsDelta: 4,
          balanceAfter: 4,
          totalLessonsAfter: 4,
        }),
        ledgerRow({
          id: 'client-1-attendance',
          clientId: 'client-1',
          type: 'attendance',
          lessonsDelta: -1,
          balanceAfter: 3,
          totalLessonsAfter: 4,
        }),
      ],
    },
    { allowUnlockedReads: true },
  )

  const adjustment = harness.request('recordAdjustment', {
    clientId: 'client-1',
    lessonsDelta: 2,
    reason: 'Компенсация отменённого занятия',
    requestId: 'adjustment-1',
  })
  assert.equal(adjustment.success, true)
  assert.equal(harness.sheets.get('Клиенты').rows[1][5], 6)
  assert.equal(harness.sheets.get('Клиенты').rows[1][6], 5)
  const adjustmentRow = harness.sheets.get('Журнал занятий').rows.at(-1)
  assert.equal(adjustmentRow[LEDGER_HEADERS.indexOf('type')], 'adjustment')
  assert.equal(adjustmentRow[LEDGER_HEADERS.indexOf('lessonsDelta')], 2)
  assert.equal(adjustmentRow[LEDGER_HEADERS.indexOf('totalLessonsDelta')], 2)
  assert.equal(adjustmentRow[LEDGER_HEADERS.indexOf('recordedBy')], 'admin')
  assert.equal(adjustmentRow[LEDGER_HEADERS.indexOf('reason')], 'Компенсация отменённого занятия')

  harness.cacheValues.clear()
  const duplicate = harness.request('recordAdjustment', {
    clientId: 'client-1',
    lessonsDelta: 2,
    reason: 'Компенсация отменённого занятия',
    requestId: 'adjustment-1',
  })
  assert.equal(duplicate.success, true)
  assert.equal(duplicate.duplicate, true)
  assert.equal(harness.sheets.get('Журнал занятий').rows.length, 4)

  const forbiddenReceipt = harness.request('uploadReceipt', {
    clientId: 'client-1',
    lessonsCount: 8,
    requestId: 'receipt-1',
  })
  assert.equal(forbiddenReceipt.status, 'error')
  assert.equal(forbiddenReceipt.code, 'VALIDATION')
  assert.equal(harness.sheets.get('Клиенты').rows[1][6], 5)
  assert.equal(
    harness.request('addLessons', { clientId: 'client-1', lessonsCount: 8, requestId: 'legacy-add-1' }).status,
    'error',
  )

  const beforeRepair = harness.request('auditLessonLedger', { clientId: 'client-2' })
  assert.equal(beforeRepair.discrepancies.length, 1)
  assert.deepEqual(beforeRepair.discrepancies[0].missingPaymentIds, ['payment-2'])
  assert.equal(beforeRepair.discrepancies[0].repairable, true)

  const repaired = harness.request('repairLessonLedger', {
    clientId: 'client-2',
    expectedRemainingLessons: 3,
    expectedTotalLessons: 4,
    reason: 'Подтверждена сверка старого платежа',
    confirmed: true,
    requestId: 'repair-1',
  })
  assert.equal(repaired.success, true)
  const afterRepair = harness.request('auditLessonLedger', { clientId: 'client-2' })
  assert.equal(afterRepair.discrepancies.length, 0)
  const repairedEntries = harness.sheets
    .get('Журнал занятий')
    .rows.filter((row, index) => index > 0 && row[LEDGER_HEADERS.indexOf('clientId')] === 'client-2')
  assert.deepEqual(
    repairedEntries.map((row) => row[LEDGER_HEADERS.indexOf('type')]),
    ['purchase_repair', 'audit_repair'],
  )
})

test('a successful receipt upload stores only a private file reference and never credits lessons', () => {
  const headers = ['id', 'branchId', 'totalLessons', 'remainingLessons', 'receiptUrl', 'status']
  const harness = createHarness({
    Клиенты: [headers, ['client-1', 'branch-1', 12, 7, '', 'Активен']],
    'Журнал занятий': [LEDGER_HEADERS],
  })

  const result = harness.request('uploadReceipt', {
    clientId: 'client-1',
    fileBase64: Buffer.from('test receipt').toString('base64'),
    fileName: 'receipt.pdf',
    mimeType: 'application/pdf',
    requestId: 'receipt-upload-1',
  })

  assert.deepEqual(result, { success: true })
  const row = harness.sheets.get('Клиенты').rows[1]
  assert.equal(row[headers.indexOf('totalLessons')], 12)
  assert.equal(row[headers.indexOf('remainingLessons')], 7)
  assert.equal(row[headers.indexOf('status')], 'Активен')
  assert.equal(row[headers.indexOf('receiptUrl')], 'drive:drive-file-1')
  assert.equal(harness.sheets.get('Журнал занятий').rows.length, 1)
  assert.deepEqual(harness.state.driveFiles[0].sharing, { access: 'PRIVATE', permission: 'NONE' })
})

test('attendance retry at zero balance is a duplicate and corrections use the ledger delta', () => {
  const headers = [
    'id',
    'branchId',
    'assignedLessonIds',
    'remainingLessons',
    'totalLessons',
    'attendanceHistory',
    'status',
    'paid',
    'purchasedAt',
    'receiptUrl',
    'paymentBalance',
  ]
  const history = JSON.stringify([{ lessonId: 'lesson-1', date: '2026-10-02', status: 'attended', isWalkin: false }])
  const harness = createHarness({
    Клиенты: [headers, ['client-1', 'branch-1', 'lesson-1', 0, 1, history, 'Пауза', true, '', '', 0]],
    Платежи: [PAYMENT_HEADERS],
    'Журнал занятий': [
      LEDGER_HEADERS,
      ledgerRow({
        id: 'grant-1',
        clientId: 'client-1',
        lessonsDelta: 1,
        totalLessonsDelta: 1,
        balanceAfter: 1,
        totalLessonsAfter: 1,
      }),
      ledgerRow({
        id: 'old-attendance-1',
        clientId: 'client-1',
        type: 'attendance',
        lessonsDelta: -1,
        balanceAfter: 0,
        totalLessonsAfter: 1,
      }),
    ],
    Расписание: [
      ['id', 'branchId', 'date', 'dayOfWeek', 'time', 'category', 'isRecurring'],
      ['lesson-1', 'branch-1', '2026-10-02', 'Пт', '17:00', 'плавание', false],
    ],
  })
  const base = { clientId: 'client-1', lessonId: 'lesson-1', date: '2026-10-02' }
  const same = harness.request('recordAttendance', { ...base, status: 'attended', requestId: 'mark-1' })
  assert.equal(same.success, true)
  assert.equal(same.results[0].duplicate, true)
  assert.equal(harness.sheets.get('Клиенты').rows[1][3], 0)

  const absent = harness.request('recordAttendance', { ...base, status: 'absent', requestId: 'mark-2' })
  assert.equal(absent.success, true)
  assert.equal(harness.sheets.get('Клиенты').rows[1][3], 1)
  const mark = JSON.parse(harness.sheets.get('Клиенты').rows[1][5])[0]
  assert.equal(mark.recordedBy, 'admin')

  const attended = harness.request('recordAttendance', { ...base, status: 'attended', requestId: 'mark-3' })
  assert.equal(attended.success, true)
  assert.equal(harness.sheets.get('Клиенты').rows[1][3], 0)
  const ledger = harness.sheets.get('Журнал занятий').rows
  assert.equal(ledger.at(-2)[LEDGER_HEADERS.indexOf('lessonsDelta')], 1)
  assert.equal(ledger.at(-1)[LEDGER_HEADERS.indexOf('lessonsDelta')], -1)
  const bypass = harness.request('recordAttendance', {
    ...base,
    status: 'attended',
    isWalkin: true,
    requestId: 'mark-4',
  })
  assert.equal(bypass.status, 'error')
  assert.equal(bypass.code, 'VALIDATION')
  assert.equal(harness.sheets.get('Клиенты').rows[1][3], 0)
})

test('failed payment responses do not poison idempotency cache', () => {
  const harness = createHarness({
    Клиенты: [
      [
        'id',
        'branchId',
        'category',
        'lessonsPerWeek',
        'paidAmount',
        'totalLessons',
        'remainingLessons',
        'paid',
        'paymentBalance',
        'status',
        'purchasedAt',
        'receiptUrl',
        'attendanceHistory',
        'assignedLessonIds',
      ],
      ['client-1', 'branch-1', 'плавание', 1, 0, 0, 0, false, 0, 'Пауза', '', '', '[]'],
    ],
    Платежи: [PAYMENT_HEADERS],
    'Журнал занятий': [LEDGER_HEADERS],
  })
  const payload = { clientId: 'client-1', amount: 1, category: 'плавание', lessonsPerWeek: 1, requestId: 'pay-fail' }
  const result = harness.request('recordPayment', payload)
  assert.equal(result.status, 'error')
  assert.equal([...harness.cacheValues.keys()].filter((key) => key.startsWith('gas-idem:')).length, 0)
})
test('payment migration adds only fingerprint header and preserves old rows', () => {
  const oldRow = ['payment-1', 'old-request', 'client-1', 'branch-1', 5500]
  const harness = createHarness({
    Платежи: [['id', 'requestId', 'clientId', 'branchId', 'amount'], oldRow],
  })
  const lock = harness.context.LockService.getScriptLock()
  assert.equal(lock.tryLock(20000), true)
  try {
    harness.context.ensurePaymentsFingerprintColumn(harness.sheets.get('Платежи'))
  } finally {
    lock.releaseLock()
  }
  const rows = harness.sheets.get('Платежи').rows
  assert.equal(rows[0][5], 'requestFingerprint')
  assert.deepEqual(rows[1], oldRow)
  assert.equal(harness.state.writes.length, 1)
})
test('legacy schedule is migrated before a dated lesson can be created', () => {
  const harness = createHarness({
    Филиалы: [
      ['id', 'name'],
      ['branch-1', 'Pool'],
    ],
    Расписание: [
      ['id', 'branchId', 'dayOfWeek', 'time', 'title', 'coachName', 'pool', 'duration', 'maxCapacity', 'count'],
      ['legacy-1', 'branch-1', 'Пт', '17:00', 'Плавание', 'Coach', 'Pool', '1 час', 10, ''],
    ],
  })
  const payload = {
    branchId: 'branch-1',
    date: '2026-10-02',
    dayOfWeek: 'Пт',
    time: '17:00',
    title: 'Плавание',
    category: 'плавание',
    isRecurring: false,
    requestId: 'dated-lesson-1',
  }
  const rejected = harness.request('createLesson', payload)
  assert.equal(rejected.status, 'error')
  assert.equal(rejected.code, 'SCHEMA')
  assert.doesNotMatch(rejected.message, /setupSchema|схем/i)
  assert.equal(harness.sheets.get('Расписание').rows.length, 2)

  const lock = harness.context.LockService.getScriptLock()
  assert.equal(lock.tryLock(20000), true)
  try {
    harness.context.ensureLessonScheduleColumns(harness.sheets.get('Расписание'))
  } finally {
    lock.releaseLock()
  }
  const rows = harness.sheets.get('Расписание').rows
  const headers = rows[0]
  assert.equal(rows[1][headers.indexOf('date')], undefined, 'unknown old dates are not fabricated')
  assert.deepEqual(
    harness.state.formats.map(({ column, format }) => [headers[column - 1], format]),
    [
      ['date', '@'],
      ['time', '@'],
    ],
  )

  const created = harness.request('createLesson', payload)
  assert.equal(created.date, '2026-10-02')
  assert.equal(created.dayOfWeek, 'Пт')
  assert.equal(created.category, 'плавание')
  assert.equal(created.isRecurring, 'false')
  assert.equal(rows.length, 3)
})
test('coach roster reads every client in the lesson branch and category, beyond the first 100', () => {
  const headers = [
    'id',
    'childName',
    'branchId',
    'assignedLessonIds',
    'remainingLessons',
    'totalLessons',
    'attendanceHistory',
    'status',
    'paid',
    'purchasedAt',
    'receiptUrl',
    'paymentBalance',
    'category',
  ]
  const client = (index, branchId = 'branch-1', assigned = 'lesson-1') => [
    'client-' + index,
    'Child ' + index,
    branchId,
    assigned,
    3,
    4,
    index === 120 ? JSON.stringify([{ lessonId: 'lesson-1', date: '2026-10-02', status: 'attended' }]) : '[]',
    'Активен',
    true,
    '',
    '',
    0,
    'плавание',
  ]
  const harness = createHarness(
    {
      Клиенты: [
        headers,
        ...Array.from({ length: 130 }, (_, index) => client(index + 1)),
        client(131, 'branch-2'),
        client(132, 'branch-1', ''),
        [...client(133).slice(0, 7), 'Архив', ...client(133).slice(8)],
        [...client(134).slice(0, 12), 'синхронное плавание'],
      ],
      Расписание: [
        ['id', 'branchId', 'date', 'dayOfWeek', 'time', 'category', 'isRecurring'],
        ['lesson-1', 'branch-1', '2026-10-02', 'Пт', '17:00', 'плавание', false],
      ],
      Платежи: [PAYMENT_HEADERS],
      'Журнал занятий': [LEDGER_HEADERS],
    },
    { allowUnlockedReads: true },
  )
  harness.context.requireServerAuth = () => ({ id: 'coach-1', username: 'coach', role: 'coach', branchId: 'branch-1' })
  const roster = harness.request('getLessonRoster', { lessonId: 'lesson-1', date: '2026-10-02' })
  assert.equal(roster.clients.length, 131)
  assert.equal(harness.state.acquisitions, 0)
  assert.equal(
    roster.clients.some((client) => client.id === 'client-134'),
    false,
  )
  assert.equal(roster.clients.find((client) => client.id === 'client-120').mark, 'attended')
  assert.equal(
    roster.clients.some((client) => client.id === 'client-131'),
    false,
  )
  assert.equal(
    roster.clients.some((client) => client.id === 'client-132'),
    true,
    'an explicit lesson assignment is not required for a group roster',
  )
  const unassignedClientRow = harness.sheets.get('Клиенты').rows.find((row) => row[0] === 'client-132')
  unassignedClientRow[headers.indexOf('remainingLessons')] = 0
  unassignedClientRow[headers.indexOf('totalLessons')] = 0
  const unassignedAttendance = harness.request('recordAttendance', {
    clientId: 'client-132',
    lessonId: 'lesson-1',
    date: '2026-10-02',
    status: 'absent',
    requestId: 'unassigned-category-client',
  })
  assert.equal(unassignedAttendance.success, true)
  const wrongCategory = harness.request('recordAttendance', {
    clientId: 'client-134',
    lessonId: 'lesson-1',
    date: '2026-10-02',
    status: 'attended',
    requestId: 'category-1',
  })
  assert.equal(wrongCategory.success, false)
  assert.equal(harness.sheets.get('Клиенты').rows[134][4], 3)
  assert.equal(
    roster.clients.some((client) => client.id === 'client-133'),
    false,
  )
  const archivedMark = harness.request('recordAttendance', {
    clientId: 'client-133',
    lessonId: 'lesson-1',
    date: '2026-10-02',
    status: 'attended',
    requestId: 'archived-1',
  })
  assert.equal(archivedMark.success, false)
  assert.equal(harness.sheets.get('Клиенты').rows[133][4], 3)
  assert.equal(harness.request('getLessonRoster', { lessonId: 'lesson-1', date: '2026-10-03' }).status, 'error')
  harness.context.requireServerAuth = () => ({ id: 'coach-2', username: 'coach2', role: 'coach', branchId: 'branch-2' })
  assert.equal(harness.request('getLessonRoster', { lessonId: 'lesson-1', date: '2026-10-02' }).status, 'error')
})

test('recurring Friday attendance is recorded per occurrence, not on the schedule template', () => {
  const harness = createHarness(
    {
      Клиенты: [
        [
          'id',
          'childName',
          'branchId',
          'assignedLessonIds',
          'remainingLessons',
          'totalLessons',
          'attendanceHistory',
          'status',
          'paid',
          'purchasedAt',
          'receiptUrl',
          'paymentBalance',
          'category',
        ],
        ['client-1', 'Child', 'branch-1', 'lesson-1', 3, 4, '[]', 'Активен', true, '', '', 0, 'плавание'],
      ],
      Платежи: [PAYMENT_HEADERS],
      'Журнал занятий': [
        LEDGER_HEADERS,
        ledgerRow({
          id: 'grant-1',
          clientId: 'client-1',
          lessonsDelta: 4,
          totalLessonsDelta: 4,
          balanceAfter: 4,
          totalLessonsAfter: 4,
        }),
        ledgerRow({
          id: 'old-attendance-1',
          clientId: 'client-1',
          type: 'attendance',
          lessonsDelta: -1,
          balanceAfter: 3,
          totalLessonsAfter: 4,
        }),
      ],
      Расписание: [
        ['id', 'branchId', 'date', 'dayOfWeek', 'time', 'category', 'isRecurring'],
        ['lesson-1', 'branch-1', '', 'Пт', '17:00', 'плавание', true],
      ],
    },
    { allowUnlockedReads: true },
  )
  const base = { clientId: 'client-1', lessonId: 'lesson-1', status: 'attended' }
  const first = harness.request('recordAttendance', { ...base, date: '2026-10-02', requestId: 'friday-1' })
  assert.equal(first.success, true)
  const second = harness.request('recordAttendance', { ...base, date: '2026-10-09', requestId: 'friday-2' })
  assert.equal(second.success, true)
  assert.equal(harness.sheets.get('Клиенты').rows[1][4], 1)
  const history = JSON.parse(harness.sheets.get('Клиенты').rows[1][6])
  assert.deepEqual(
    history.map(({ date }) => date),
    ['2026-10-02', '2026-10-09'],
  )
  assert.equal(harness.sheets.get('Журнал занятий').rows.at(-1)[LEDGER_HEADERS.indexOf('balanceAfter')], 1)
  const wrongDay = harness.request('recordAttendance', { ...base, date: '2026-10-10', requestId: 'saturday' })
  assert.equal(wrongDay.success, false)
  assert.equal(harness.sheets.get('Клиенты').rows[1][4], 1)
})

test('trainer schema migration adds account, phone and birth date columns without rewriting cards', () => {
  const harness = createHarness({
    Тренеры: [
      ['id', 'name', 'specialty', 'branchId'],
      ['trainer-1', 'Coach One', 'Плавание', 'branch-1'],
    ],
  })
  const lock = harness.context.LockService.getScriptLock()
  assert.equal(lock.tryLock(20000), true)
  try {
    harness.context.ensureCoachUserIdColumn(harness.sheets.get('Тренеры'))
  } finally {
    lock.releaseLock()
  }
  assert.deepEqual(harness.sheets.get('Тренеры').rows[0], [
    'id',
    'name',
    'specialty',
    'branchId',
    'userId',
    'phone',
    'birthDate',
  ])
  assert.deepEqual(harness.sheets.get('Тренеры').rows[1].slice(0, 4), [
    'trainer-1',
    'Coach One',
    'Плавание',
    'branch-1',
  ])
})

test('coach accounts are created atomically, can be disabled, and are deactivated with their linked card', () => {
  const usersHeaders = ['id', 'username', 'password', 'role', 'branchId', 'status', 'disabledAt', 'disabledBy']
  const coachHeaders = ['id', 'name', 'specialty', 'initials', 'branchId', 'userId', 'phone', 'birthDate']
  const harness = createHarness({
    Users: [usersHeaders, ['admin-1', 'admin', 'hash', '1', '', 'Активен', '', '']],
    Тренеры: [coachHeaders],
    Филиалы: [
      ['id', 'name', 'address'],
      ['branch-1', 'Pool', 'Street'],
    ],
  })

  const created = harness.request('createCoach', {
    name: 'Coach One',
    specialty: 'Плавание',
    branchId: 'branch-1',
    username: 'coach.one',
    passwordHash: 'scrypt$16384$8$1$abcdefghijklmnopqrstuv$' + 'a'.repeat(86),
    phone: '+7 (999) 123-45-67',
    birthDate: '01.02.1990',
    requestId: 'coach-create-1',
  })
  assert.equal(created.name, 'Coach One')
  assert.equal(created.phone, '+7 (999) 123-45-67')
  assert.equal(created.birthDate, '01.02.1990')
  const users = harness.sheets.get('Users').rows
  const coaches = harness.sheets.get('Тренеры').rows
  const userId = users[2][0]
  assert.equal(users.length, 3)
  assert.equal(users[2][1], 'coach.one')
  assert.equal(users[2][3], '2')
  assert.equal(users[2][4], 'branch-1')
  assert.equal(users[2][5], 'Активен')
  assert.match(users[2][2], /^scrypt\$/)
  assert.equal(coaches[1][5], userId)
  assert.equal(coaches[1][6], "'+7 (999) 123-45-67")
  assert.equal(coaches[1][7], '01.02.1990')

  const invalidBirthDate = harness.request('createCoach', {
    name: 'Invalid Date',
    specialty: 'Плавание',
    branchId: 'branch-1',
    birthDate: '31.02.1990',
    requestId: 'coach-invalid-date',
  })
  assert.equal(invalidBirthDate.status, 'error')
  assert.equal(invalidBirthDate.code, 'VALIDATION')

  const cacheKey = harness.context.authUserCacheKey(userId)
  harness.cacheValues.set(
    cacheKey,
    JSON.stringify({ id: userId, username: 'coach.one', role: 'coach', branchId: 'branch-1' }),
  )
  assert.deepEqual(harness.request('deactivateUser', { userId, requestId: 'coach-disable-1' }), { success: true })
  assert.equal(users[2][5], 'Отключен')
  assert.equal(users[2][7], 'admin')
  assert.equal(harness.cacheValues.has(cacheKey), false)

  assert.deepEqual(harness.request('activateUser', { userId, requestId: 'coach-enable-1' }), { success: true })
  assert.equal(users[2][5], 'Активен')
  assert.equal(users[2][6], '')
  assert.equal(users[2][7], '')

  assert.deepEqual(
    harness.request('resetCoachPassword', {
      userId,
      passwordHash: 'scrypt$16384$8$1$abcdefghijklmnopqrstuv$' + 'b'.repeat(86),
      requestId: 'coach-password-1',
    }),
    { success: true },
  )
  assert.match(users[2][2], /^scrypt\$/)

  assert.deepEqual(harness.request('deleteCoach', { id: created.id, requestId: 'coach-delete-1' }), { success: true })
  assert.equal(coaches.length, 1)
  assert.equal(users[2][5], 'Отключен')
  assert.equal(users[2][7], 'admin')
})

test('legacy account can only be linked to one trainer from the same branch', () => {
  const harness = createHarness({
    Users: [
      ['id', 'username', 'password', 'role', 'branchId', 'status', 'disabledAt', 'disabledBy'],
      ['admin-1', 'admin', 'hash', '1', '', 'Активен', '', ''],
      ['coach-1', 'coach', 'hash', '2', 'branch-1', 'Активен', '', ''],
    ],
    Тренеры: [
      ['id', 'name', 'specialty', 'branchId', 'userId', 'phone', 'birthDate'],
      ['trainer-1', 'Coach One', 'Плавание', 'branch-1', '', '', ''],
      ['trainer-2', 'Coach Two', 'Плавание', 'branch-1', '', '', ''],
    ],
  })

  assert.deepEqual(
    harness.request('linkCoachUser', { coachId: 'trainer-1', userId: 'coach-1', requestId: 'coach-link-1' }),
    { success: true },
  )
  assert.equal(harness.sheets.get('Тренеры').rows[1][4], 'coach-1')
  const duplicate = harness.request('linkCoachUser', {
    coachId: 'trainer-2',
    userId: 'coach-1',
    requestId: 'coach-link-2',
  })
  assert.equal(duplicate.status, 'error')
  assert.equal(duplicate.code, 'CONFLICT')
})

test('audit does not silently repair a payment with an unknown lesson credit', () => {
  const headers = [
    'id',
    'branchId',
    'category',
    'lessonsPerWeek',
    'paidAmount',
    'totalLessons',
    'remainingLessons',
    'paid',
    'paymentBalance',
    'status',
    'purchasedAt',
    'receiptUrl',
    'attendanceHistory',
    'assignedLessonIds',
  ]
  const harness = createHarness(
    {
      Клиенты: [headers, ['client-1', 'branch-1', 'плавание', 1, 5500, 0, 0, true, 0, 'Пауза', '', '', '[]']],
      Платежи: [
        PAYMENT_HEADERS,
        [
          'payment-1',
          'legacy-payment',
          'client-1',
          'branch-1',
          5500,
          'плавание',
          1,
          5500,
          4,
          1,
          '',
          '2026-09-01',
          'admin',
          '',
          'legacy',
        ],
      ],
      'Журнал занятий': [LEDGER_HEADERS],
    },
    { allowUnlockedReads: true },
  )

  const audit = harness.request('auditLessonLedger', { clientId: 'client-1' })
  assert.equal(audit.discrepancies.length, 1)
  assert.equal(audit.discrepancies[0].repairable, false)
  assert.match(audit.discrepancies[0].paymentIssues[0], /не содержит корректного числа/)

  const repair = harness.request('repairLessonLedger', {
    clientId: 'client-1',
    expectedRemainingLessons: 0,
    expectedTotalLessons: 0,
    reason: 'Нельзя угадывать старое начисление',
    confirmed: true,
    requestId: 'repair-unknown-payment',
  })
  assert.equal(repair.status, 'error')
  assert.equal(repair.code, 'CONFLICT')
})

test('administrative status and account changes write only changed cells and leave one audit trail', () => {
  const clientHeaders = ['id', 'branchId', 'status', 'lessonsPerWeek', 'note']
  const userHeaders = ['id', 'username', 'password', 'role', 'branchId', 'status', 'disabledAt', 'disabledBy']
  const harness = createHarness({
    Клиенты: [clientHeaders, ['client-1', 'branch-1', 'Активен', 1, 'keep']],
    Users: [
      userHeaders,
      [
        'coach-1',
        'coach',
        'scrypt$16384$8$1$abcdefghijklmnopqrstuv$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvabcdefghijklmnopqrstuvabcdefghijklmnopqrstuv',
        '2',
        'branch-1',
        'Активен',
        '',
        '',
      ],
    ],
  })

  const archive = harness.request('updateClient', { id: 'client-1', status: 'Архив', requestId: 'archive-client-1' })
  assert.deepEqual(archive, { success: true })
  const clientWrites = harness.state.writes.filter((write) => write.name === 'Клиенты')
  assert.deepEqual(clientWrites, [{ name: 'Клиенты', row: 2, column: 3, height: 1, width: 1 }])

  const deactivate = harness.request('deactivateUser', { userId: 'coach-1', requestId: 'disable-coach-1' })
  assert.deepEqual(deactivate, { success: true })
  const userWrites = harness.state.writes.filter((write) => write.name === 'Users')
  assert.deepEqual(userWrites, [{ name: 'Users', row: 2, column: 6, height: 1, width: 3 }])

  const audit = harness.sheets.get('Журнал администрирования').rows
  const auditHeaders = audit[0]
  const auditActionIdx = auditHeaders.indexOf('action')
  const auditRequestIdx = auditHeaders.indexOf('requestId')
  const auditFieldsIdx = auditHeaders.indexOf('changedFields')
  assert.equal(audit.length, 3)
  assert.equal(audit[1][auditActionIdx], 'updateClient')
  assert.equal(audit[1][auditRequestIdx], 'archive-client-1')
  assert.equal(audit[1][auditFieldsIdx], 'status')
  assert.equal(audit[2][auditActionIdx], 'deactivateUser')
  assert.equal(audit[2][auditFieldsIdx], 'status,disabledAt,disabledBy')

  harness.cacheValues.clear()
  const duplicate = harness.request('deactivateUser', { userId: 'coach-1', requestId: 'disable-coach-1' })
  assert.deepEqual(duplicate, { success: true, duplicate: true })
  assert.equal(harness.sheets.get('Журнал администрирования').rows.length, 3)
})

test('manual edit of an accounting column is locked and recorded without exposing cell values', () => {
  const headers = ['id', 'branchId', 'remainingLessons', 'totalLessons', 'status']
  const harness = createHarness({
    Клиенты: [headers, ['client-1', 'branch-1', 4, 4, 'Активен']],
  })
  harness.sheets.get('Клиенты').rows[1][2] = 99
  harness.context.onEdit({
    range: {
      getSheet: () => harness.sheets.get('Клиенты'),
      getColumn: () => 3,
      getNumColumns: () => 1,
      getA1Notation: () => 'C2',
    },
  })

  assert.equal(harness.state.held, false)
  assert.equal(harness.state.acquisitions, 1)
  const audit = harness.sheets.get('Журнал администрирования').rows
  const headersIndex = audit[0]
  assert.equal(audit.length, 2)
  assert.equal(audit[1][headersIndex.indexOf('action')], 'manual_sheet_edit_detected')
  assert.equal(audit[1][headersIndex.indexOf('changedFields')], 'remainingLessons')
  assert.equal(audit[1][headersIndex.indexOf('source')], 'Google Sheets')
  assert.equal(audit[1].includes(99), false)
})

test('payment and archive serialize without losing either the balance or archived status', () => {
  const clientHeaders = [
    'id',
    'branchId',
    'category',
    'lessonsPerWeek',
    'paidAmount',
    'totalLessons',
    'remainingLessons',
    'paid',
    'paymentBalance',
    'status',
    'purchasedAt',
    'receiptUrl',
    'attendanceHistory',
    'assignedLessonIds',
  ]
  const createArchivedHarness = () =>
    createHarness({
      Клиенты: [clientHeaders, ['client-1', 'branch-1', 'плавание', 1, 5500, 4, 3, true, 0, 'Архив', '', '', '[]']],
      Платежи: [PAYMENT_HEADERS],
      'Журнал занятий': [
        LEDGER_HEADERS,
        ledgerRow({
          id: 'purchase-1',
          clientId: 'client-1',
          type: 'purchase',
          lessonsDelta: 4,
          totalLessonsDelta: 4,
          balanceAfter: 4,
          totalLessonsAfter: 4,
        }),
        ledgerRow({
          id: 'attendance-1',
          clientId: 'client-1',
          type: 'attendance',
          lessonsDelta: -1,
          balanceAfter: 3,
          totalLessonsAfter: 4,
        }),
      ],
    })

  const archivedFirst = createArchivedHarness()
  const latePayment = archivedFirst.request('recordPayment', {
    clientId: 'client-1',
    amount: 5500,
    category: 'плавание',
    lessonsPerWeek: 1,
    requestId: 'late-payment-1',
  })
  assert.equal(latePayment.success, true)
  assert.equal(archivedFirst.sheets.get('Клиенты').rows[1][5], 8)
  assert.equal(archivedFirst.sheets.get('Клиенты').rows[1][6], 7)
  assert.equal(archivedFirst.sheets.get('Клиенты').rows[1][9], 'Архив')

  const paymentFirst = createArchivedHarness()
  paymentFirst.sheets.get('Клиенты').rows[1][9] = 'Активен'
  assert.equal(
    paymentFirst.request('recordPayment', {
      clientId: 'client-1',
      amount: 5500,
      category: 'плавание',
      lessonsPerWeek: 1,
      requestId: 'payment-before-archive-1',
    }).success,
    true,
  )
  assert.deepEqual(
    paymentFirst.request('updateClient', { id: 'client-1', status: 'Архив', requestId: 'archive-after-payment-1' }),
    {
      success: true,
    },
  )
  const finalRow = paymentFirst.sheets.get('Клиенты').rows[1]
  assert.equal(finalRow[5], 8)
  assert.equal(finalRow[6], 7)
  assert.equal(finalRow[9], 'Архив')
})

test('server summaries, subscriptions and client option search cover clients beyond the first page', () => {
  const headers = [
    'id',
    'childName',
    'parentName',
    'phone',
    'email',
    'branchId',
    'status',
    'paidAmount',
    'totalLessons',
    'remainingLessons',
    'initials',
  ]
  const clients = Array.from({ length: 500 }, (_, index) => [
    'client-' + (index + 1),
    'Ученик ' + (index + 1),
    'Родитель ' + (index + 1),
    '+7999000' + String(index + 1).padStart(4, '0'),
    'family' + (index + 1) + '@example.test',
    'branch-1',
    index === 498 ? 'Пауза' : 'Активен',
    index + 1,
    8,
    index % 5,
    'У',
  ])
  const harness = createHarness({ Клиенты: [headers, ...clients] }, { allowUnlockedReads: true })

  const dashboard = harness.request('getDashboardSummary', { branchId: 'branch-1', previewLimit: 5 })
  assert.equal(dashboard.totalClients, 500)
  assert.equal(dashboard.activeClients, 499)
  assert.equal(dashboard.pausedClients, 1)
  assert.equal(dashboard.clientsPreview.length, 5)
  assert.equal(dashboard.previewTotal, 500)

  const finance = harness.request('getFinanceSummary', { branchId: 'branch-1' })
  assert.equal(finance.totalClients, 500)
  assert.equal(finance.totalPaidAmount, (500 * 501) / 2)
  assert.equal(
    finance.remainingLessons,
    clients.reduce((total, row) => total + row[9], 0),
  )

  const subscriptions = harness.request('getSubscriptionsPage', { branchId: 'branch-1', page: 2, pageSize: 100 })
  assert.equal(subscriptions.total, 500)
  assert.equal(subscriptions.items.length, 100)
  assert.equal(subscriptions.hasMore, true)

  const options = harness.request('searchClientOptions', { branchId: 'branch-1', query: 'Ученик 500', limit: 20 })
  assert.deepEqual(options.items, [
    {
      id: 'client-500',
      childName: 'Ученик 500',
      parentName: 'Родитель 500',
      branchId: 'branch-1',
      category: 'плавание',
      remainingLessons: 4,
    },
  ])
})

test('client option search returns only active clients from the selected lesson category', () => {
  const harness = createHarness(
    {
      Клиенты: [
        ['id', 'childName', 'parentName', 'branchId', 'status', 'category', 'remainingLessons'],
        ['swim-1', 'Катя', 'Маша', 'branch-1', 'Активен', 'плавание', 8],
        ['legacy-swim', 'Маша', 'Катя', 'branch-1', 'Активен', '', 3],
        ['sync-1', 'Петя', 'Вася', 'branch-1', 'Активен', 'синхронное плавание', 8],
        ['swim-paused', 'Лена', 'Оля', 'branch-1', 'Пауза', 'плавание', 4],
      ],
    },
    { allowUnlockedReads: true },
  )

  const options = harness.request('searchClientOptions', {
    branchId: 'branch-1',
    category: 'плавание',
    limit: 20,
  })

  assert.deepEqual(
    options.items.map((item) => item.id),
    ['swim-1', 'legacy-swim'],
  )
  assert.equal(options.items.find((item) => item.id === 'legacy-swim').category, 'плавание')
})

test('assignClientLesson appends one lesson under the mutation lock without replacing existing assignments', () => {
  const harness = createHarness({
    Клиенты: [
      ['id', 'branchId', 'status', 'assignedLessonId', 'assignedLessonIds'],
      ['client-1', 'branch-1', 'Активен', 'lesson-old', 'lesson-old,lesson-other'],
    ],
    Расписание: [
      ['id', 'branchId'],
      ['lesson-new', 'branch-1'],
    ],
  })

  assert.deepEqual(
    harness.request('assignClientLesson', {
      clientId: 'client-1',
      lessonId: 'lesson-new',
      requestId: 'assign-client-lesson-1',
    }),
    { success: true, alreadyAssigned: false },
  )
  assert.equal(harness.state.acquisitions, 1)
  assert.equal(harness.sheets.get('Клиенты').rows[1][3], 'lesson-old')
  assert.equal(harness.sheets.get('Клиенты').rows[1][4], 'lesson-old,lesson-other,lesson-new')
})

test('bootstrap loads branches, coaches and lessons through one cached GAS request', () => {
  const harness = createHarness(
    {
      Филиалы: [
        ['id', 'name'],
        ['branch-1', 'Pool 1'],
        ['branch-2', 'Pool 2'],
      ],
      Тренеры: [
        ['id', 'name', 'branchId'],
        ['coach-1', 'Coach 1', 'branch-1'],
        ['coach-2', 'Coach 2', 'branch-2'],
      ],
      Расписание: [
        ['id', 'title', 'branchId'],
        ['lesson-1', 'Lesson 1', 'branch-1'],
        ['lesson-2', 'Lesson 2', 'branch-2'],
      ],
    },
    { allowUnlockedReads: true },
  )

  const first = harness.request('getBootstrapData', { branchId: 'branch-1' })
  assert.deepEqual(
    first.branches.map((branch) => branch.id),
    ['branch-1', 'branch-2'],
  )
  assert.deepEqual(
    first.coaches.map((coach) => coach.id),
    ['coach-1'],
  )
  assert.deepEqual(
    first.lessons.map((lesson) => lesson.id),
    ['lesson-1'],
  )

  const readsAfterFirstRequest = harness.state.events.filter((event) => event.startsWith('read:')).length
  const second = harness.request('getBootstrapData', { branchId: 'branch-1' })
  assert.deepEqual(second, first)
  assert.equal(
    harness.state.events.filter((event) => event.startsWith('read:')).length,
    readsAfterFirstRequest,
    'the second bootstrap is served from script cache',
  )
})

test('createLesson creates and assigns a lesson to a client in one mutation', () => {
  const harness = createHarness({
    Филиалы: [
      ['id', 'name'],
      ['branch-1', 'Pool'],
    ],
    Клиенты: [
      ['id', 'branchId', 'status', 'assignedLessonIds'],
      ['client-1', 'branch-1', 'Активен', 'lesson-old'],
    ],
    Расписание: [['id', 'branchId', 'date', 'dayOfWeek', 'time', 'title', 'category', 'isRecurring']],
  })

  const created = harness.request('createLesson', {
    branchId: 'branch-1',
    clientId: 'client-1',
    date: '2026-10-04',
    dayOfWeek: 'Вс',
    time: '17:00',
    title: 'Плавание',
    category: 'плавание',
    isRecurring: false,
    requestId: 'create-and-assign-1',
  })

  assert.equal(created.clientAssigned, true)
  assert.equal(harness.state.acquisitions, 1)
  assert.equal(harness.sheets.get('Расписание').rows.length, 2)
  assert.match(harness.sheets.get('Клиенты').rows[1][3], /^lesson-old,\d+-\d+$/)
  assert.equal(
    harness.state.events.filter((event) => event === 'read:Расписание').length,
    1,
    'the just-created lesson is reused without rereading the schedule',
  )
})

test('createLesson removes the new lesson when client assignment fails', () => {
  const harness = createHarness({
    Филиалы: [
      ['id', 'name'],
      ['branch-1', 'Pool'],
    ],
    Клиенты: [['id', 'branchId', 'status', 'assignedLessonIds']],
    Расписание: [['id', 'branchId', 'date', 'dayOfWeek', 'time', 'title', 'category', 'isRecurring']],
  })

  const result = harness.request('createLesson', {
    branchId: 'branch-1',
    clientId: 'missing-client',
    date: '2026-10-04',
    dayOfWeek: 'Вс',
    time: '17:00',
    title: 'Плавание',
    category: 'плавание',
    isRecurring: false,
    requestId: 'create-and-assign-failure-1',
  })

  assert.equal(result.status, 'error')
  assert.equal(result.code, 'NOT_FOUND')
  assert.equal(harness.sheets.get('Расписание').rows.length, 1)
})
