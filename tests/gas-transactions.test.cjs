const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const gas = fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8')

function createHarness(sheetData, { allowUnlockedReads = false } = {}) {
  const state = { held: false, acquisitions: 0, events: [], writes: [], formats: [] }
  const sheets = new Map()

  for (const [name, rows] of Object.entries(sheetData)) {
    const data = rows.map((row) => row.slice())
    const assertLocked = () => assert.equal(state.held, true, name + ' accessed outside the mutation lock')
    sheets.set(name, {
      rows: data,
      getName: () => name,
      getLastColumn: () => data[0].length,
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
    })
  }

  const cacheValues = new Map()
  const cache = {
    get: (key) => cacheValues.get(key) || null,
    put: (key, value) => cacheValues.set(key, value),
    remove: (key) => cacheValues.delete(key),
  }
  const properties = new Map([
    ['GAS_API_SECRET', 's'.repeat(32)],
    ['SCHEMA_VERSION', '6'],
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
        getSheetByName: (name) => sheets.get(name) || null,
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
      computeHmacSha256Signature: (value, key) => Array.from(crypto.createHmac('sha256', String(key)).update(String(value)).digest()),
      getUuid: () => '12345678-1234-1234-1234-123456789abc',
    },
  }
  vm.createContext(context)
  vm.runInContext(gas, context)
  context.requireServerAuth = () => ({ id: 'admin-1', username: 'admin', role: 'admin', branchId: null })
  context.verifySignedEnvelope = () => state.envelope

  function request(action, payload) {
    state.envelope = { action, payload, auth: { id: 'admin-1', role: 'admin' } }
    const response = context.doPost({ postData: { contents: JSON.stringify({ apiKey: 's'.repeat(32) }) } })
    return JSON.parse(response.value)
  }

  return { request, state, sheets, cacheValues, properties, context }
}

test('client mutations read snapshots under one lock and release it after flush', () => {
  const harness = createHarness({
    Клиенты: [
      ['id', 'remainingLessons', 'totalLessons', 'status', 'branchId', 'note'],
      ['client-1', 2, 4, 'Активен', 'branch-1', 'keep'],
      ['client-2', 7, 8, 'Активен', 'branch-1', 'untouched'],
    ],
  })

  assert.deepEqual(harness.request('addLessons', { clientId: 'client-1', lessonsCount: 3, requestId: 'add-1' }), {
    success: true,
  })
  assert.equal(harness.state.acquisitions, 1)
  assert.deepEqual(harness.state.events.slice(-2), ['flush', 'unlock'])
  assert.equal(harness.state.held, false)
  assert.equal(harness.sheets.get('Клиенты').rows[1][1], 5)
  assert.equal(harness.sheets.get('Клиенты').rows[2][1], 7)

  assert.deepEqual(harness.request('deleteClient', { id: 'client-1', requestId: 'delete-1' }), { success: true })
  assert.equal(harness.state.acquisitions, 2)
  assert.equal(harness.sheets.get('Клиенты').rows[1][0], 'client-2')
  assert.deepEqual(harness.state.events.slice(-2), ['flush', 'unlock'])
})

test('attendance writes only changed cells and leaves unrelated clients intact', () => {
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
  const harness = createHarness({
    Клиенты: [headers, client('client-1', 'first'), client('client-2', 'untouched'), client('client-3', 'third')],
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
  assert.deepEqual(harness.state.events.slice(-2), ['flush', 'unlock'])
  const rows = harness.sheets.get('Клиенты').rows
  assert.equal(rows[1][3], 2)
  assert.equal(rows[2][3], 3)
  assert.equal(rows[3][3], 3)
  assert.equal(rows[2][5], '[]')
  assert.equal(rows[2][11], 'untouched')
  assert.equal(harness.state.writes.length, 6)
  assert(
    harness.state.writes.every(
      (write) =>
        write.name === 'Клиенты' &&
        [2, 4].includes(write.row) &&
        [4, 6, 7].includes(write.column) &&
        write.width === 1 &&
        write.height === 1,
    ),
  )
})

test('mutation errors release the lock without writing client rows', () => {
  const harness = createHarness({
    Клиенты: [
      ['id', 'remainingLessons', 'totalLessons', 'status'],
      ['client-1', 2, 4, 'Активен'],
    ],
  })
  const result = harness.request('addLessons', { clientId: 'missing', lessonsCount: 2, requestId: 'missing-1' })
  assert.equal(result.status, 'error')
  assert.equal(harness.state.held, false)
  assert.deepEqual(harness.state.events.slice(-2), ['flush', 'unlock'])
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
  ]
  const harness = createHarness({
    Клиенты: [clientHeaders],
    Филиалы: [
      ['id', 'name', 'address'],
      ['branch-1', 'Pool', 'Street'],
    ],
    Платежи: [
      [
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
      ],
    ],
    'Журнал занятий': [
      [
        'id',
        'requestId',
        'clientId',
        'branchId',
        'paymentId',
        'type',
        'lessonsDelta',
        'balanceAfter',
        'createdAt',
        'recordedBy',
        'comment',
      ],
    ],
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
  assert.deepEqual(harness.state.events.slice(-2), ['flush', 'unlock'])
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
  assert.match(result.message, /setupSchema/)
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
  ]
  const harness = createHarness({
    Клиенты: [clientHeaders, ['client-1', 'branch-1', 'плавание', 1, 0, 0, 0, false, 0, 'Пауза', '', '', '[]']],
    Платежи: [
      [
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
      ],
    ],
    'Журнал занятий': [
      [
        'id',
        'requestId',
        'clientId',
        'branchId',
        'paymentId',
        'type',
        'lessonsDelta',
        'balanceAfter',
        'createdAt',
        'recordedBy',
        'comment',
      ],
    ],
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
  assert.match(changed.message, /requestId/)
  assert.equal(harness.sheets.get('Платежи').rows.length, 2)
})

test('attendance retry at zero balance is a duplicate and corrections use the delta', () => {
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
  const bypass = harness.request('recordAttendance', {
    ...base,
    status: 'attended',
    isWalkin: true,
    requestId: 'mark-4',
  })
  assert.equal(bypass.success, false)
  assert.match(bypass.results[0].message, /Проходное/)
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
      ],
      ['client-1', 'branch-1', 'плавание', 1, 0, 0, 0, false, 0, 'Пауза', '', '', '[]'],
    ],
    Платежи: [
      [
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
      ],
    ],
    'Журнал занятий': [
      [
        'id',
        'requestId',
        'clientId',
        'branchId',
        'paymentId',
        'type',
        'lessonsDelta',
        'balanceAfter',
        'createdAt',
        'recordedBy',
        'comment',
      ],
    ],
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
  assert.match(rejected.message, /setupSchema/)
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
test('coach roster reads all assigned clients, beyond the first 100, without exposing another branch', () => {
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
    },
    { allowUnlockedReads: true },
  )
  harness.context.requireServerAuth = () => ({ id: 'coach-1', username: 'coach', role: 'coach', branchId: 'branch-1' })
  const roster = harness.request('getLessonRoster', { lessonId: 'lesson-1', date: '2026-10-02' })
  assert.equal(roster.clients.length, 130)
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
  const wrongDay = harness.request('recordAttendance', { ...base, date: '2026-10-10', requestId: 'saturday' })
  assert.equal(wrongDay.success, false)
  assert.equal(harness.sheets.get('Клиенты').rows[1][4], 1)
})


test('coach accounts are created atomically, can be disabled, and are deactivated with their linked card', () => {
  const usersHeaders = ['id', 'username', 'password', 'role', 'branchId', 'status', 'disabledAt', 'disabledBy']
  const coachHeaders = ['id', 'name', 'specialty', 'initials', 'branchId', 'userId']
  const harness = createHarness({
    Users: [usersHeaders, ['admin-1', 'admin', 'hash', '1', '', 'Активен', '', '']],
    Тренеры: [coachHeaders],
    Филиалы: [['id', 'name', 'address'], ['branch-1', 'Pool', 'Street']],
  })

  const created = harness.request('createCoach', {
    name: 'Coach One',
    specialty: 'Плавание',
    branchId: 'branch-1',
    username: 'coach.one',
    password: 'temporary-password',
    requestId: 'coach-create-1',
  })
  assert.equal(created.name, 'Coach One')
  const users = harness.sheets.get('Users').rows
  const coaches = harness.sheets.get('Тренеры').rows
  const userId = users[2][0]
  assert.equal(users.length, 3)
  assert.equal(users[2][1], 'coach.one')
  assert.equal(users[2][3], '2')
  assert.equal(users[2][4], 'branch-1')
  assert.equal(users[2][5], 'Активен')
  assert.match(users[2][2], /^v2\$/)
  assert.equal(coaches[1][5], userId)

  const cacheKey = harness.context.authUserCacheKey(userId)
  harness.cacheValues.set(cacheKey, JSON.stringify({ id: userId, username: 'coach.one', role: 'coach', branchId: 'branch-1' }))
  assert.deepEqual(harness.request('deactivateUser', { userId, requestId: 'coach-disable-1' }), { success: true })
  assert.equal(users[2][5], 'Отключен')
  assert.equal(users[2][7], 'admin')
  assert.equal(harness.cacheValues.has(cacheKey), false)

  assert.deepEqual(harness.request('activateUser', { userId, requestId: 'coach-enable-1' }), { success: true })
  assert.equal(users[2][5], 'Активен')
  assert.equal(users[2][6], '')
  assert.equal(users[2][7], '')

  assert.deepEqual(harness.request('resetCoachPassword', { userId, newPassword: 'new-temporary-password', requestId: 'coach-password-1' }), { success: true })
  assert.match(users[2][2], /^v2\$/)

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
      ['id', 'name', 'specialty', 'branchId', 'userId'],
      ['trainer-1', 'Coach One', 'Плавание', 'branch-1', ''],
      ['trainer-2', 'Coach Two', 'Плавание', 'branch-1', ''],
    ],
  })

  assert.deepEqual(harness.request('linkCoachUser', { coachId: 'trainer-1', userId: 'coach-1', requestId: 'coach-link-1' }), { success: true })
  assert.equal(harness.sheets.get('Тренеры').rows[1][4], 'coach-1')
  const duplicate = harness.request('linkCoachUser', { coachId: 'trainer-2', userId: 'coach-1', requestId: 'coach-link-2' })
  assert.equal(duplicate.status, 'error')
  assert.match(duplicate.message, /уже связан/)
})
