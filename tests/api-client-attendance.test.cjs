const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api-client.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText

function apiWithFetch(fetch, timers = {}) {
  const exports = {}
  const context = {
    exports,
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    ...timers,
    console: { log() {} },
    require: (name) => {
      if (name === './attendance-recovery') return require('../.test-dist/attendance-recovery.js')
      if (name === './dev-log') return { devLog() {} }
      assert.equal(name, './normalizers')
      return { normalizeClient: (value) => value, normalizeLesson: (value) => value }
    },
  }
  vm.createContext(context)
  vm.runInContext(compiled, context)
  return exports.apiClient
}

const accountingSnapshot = {
  remainingLessons: 4,
  totalLessons: 4,
  paidAmount: 5500,
  paymentBalance: 0,
  category: 'плавание',
  lessonsPerWeek: 1,
  status: 'Активен',
}
test('combined accounting sends includeAudit and normally performs one request', async () => {
  const requests = []
  const api = apiWithFetch(async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        payments: [{ id: 'payment-1' }],
        ledger: [{ id: 'ledger-1' }],
        client: accountingSnapshot,
        audit: { success: true, checked: 1, discrepancies: [] },
      }),
    }
  })
  const result = await api.getClientAccounting('client-1')
  assert.deepEqual(requests, [{ action: 'getClientHistory', payload: { clientId: 'client-1', includeAudit: true } }])
  assert.equal(result.payments.length, 1)
  assert.equal(result.client.remainingLessons, 4)
  assert.equal(result.audit.success, true)
})

test('explicit audit failure retains history with no second GAS call; old GAS alone uses compatibility fallback', async () => {
  for (const oldGas of [false, true]) {
    const actions = []
    const api = apiWithFetch(async (_url, options) => {
      const { action } = JSON.parse(options.body)
      actions.push(action)
      if (action === 'auditLessonLedger') throw new Error('audit offline')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          payments: [{ id: 'payment-1' }],
          ledger: [],
          ...(oldGas ? {} : { audit: null, auditError: { code: 'SCHEMA', message: 'Сверка недоступна' } }),
        }),
      }
    })
    const result = await api.getClientAccounting('client-1')
    assert.equal(result.payments.length, 1)
    assert.equal(result.audit, null)
    assert(result.auditError.message)
    assert.deepEqual(actions, oldGas ? ['getClientHistory', 'auditLessonLedger'] : ['getClientHistory'])
  }
})

test('invalid accounting history is a load failure, not an empty payment history', async () => {
  for (const response of [
    { success: true },
    { success: true, payments: null, ledger: [] },
    { success: true, payments: [{ amount: 5500 }], ledger: [] },
    { success: true, payments: [{ id: 'same' }, { id: 'same' }], ledger: [] },
  ]) {
    const api = apiWithFetch(async () => ({ ok: true, status: 200, json: async () => response }))
    await assert.rejects(api.getClientAccounting('client-1'), (error) => error.code === 'INVALID_RESPONSE')
  }
})

test('payment acknowledgement validates authoritative counters and preserves the explicit retry ID', async () => {
  for (const client of [
    accountingSnapshot,
    { ...accountingSnapshot, remainingLessons: NaN },
    { ...accountingSnapshot, totalLessons: -1 },
  ]) {
    const requests = []
    const api = apiWithFetch(async (_url, options) => {
      requests.push(JSON.parse(options.body))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          payment: { id: 'payment-1', clientId: 'client-1', requestId: 'retry-1' },
          client,
          ledgerEntry: { id: 'ledger-1', paymentId: 'payment-1' },
          audit: { success: true, checked: 1, discrepancies: [] },
        }),
      }
    })
    if (client === accountingSnapshot) {
      const result = await api.recordPayment('client-1', 5500, 'плавание', 1, '', 'retry-1')
      assert.equal(result.ledgerEntry.id, 'ledger-1')
      assert.equal(result.client.remainingLessons, 4)
    } else {
      await assert.rejects(
        api.recordPayment('client-1', 5500, 'плавание', 1, '', 'retry-1'),
        (error) => error.code === 'INVALID_RESPONSE',
      )
    }
    assert.equal(requests[0].payload.requestId, 'retry-1')
  }
})

test('registration uses its public auth endpoint with one stable explicit attempt ID', async () => {
  const requests = []
  const api = apiWithFetch(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), credentials: options.credentials })
    if (requests.length === 1) throw new Error('network lost')
    return { ok: true, status: 200, json: async () => ({ status: 'success', pending: true }) }
  })
  await assert.rejects(api.register('new.coach', 'strong-password', 'registration-1'), /Сервис не ответил/)
  await api.register('new.coach', 'strong-password', 'registration-1')
  assert.deepEqual(requests[0], {
    url: '/api/auth/register',
    body: { username: 'new.coach', password: 'strong-password', requestId: 'registration-1' },
    credentials: 'same-origin',
  })
  assert.deepEqual(requests[1], requests[0])
})

test('registration requires an explicit pending-account acknowledgement', async () => {
  for (const data of [
    null,
    {},
    { status: 'success' },
    { status: 'success', pending: false },
    { status: 'error', pending: true },
  ]) {
    const api = apiWithFetch(async () => ({ ok: true, status: 200, json: async () => data }))
    await assert.rejects(api.register('new.coach', 'strong-password', 'registration-1'))
  }
})

test('attendance batches more than 100 marks and reuses stable chunk IDs on retry', async () => {
  const requests = []
  const saved = new Set()
  let failSecondChunkOnce = true
  const fetch = async (_url, options) => {
    const { action, payload } = JSON.parse(options.body)
    assert.equal(action, 'recordBulkAttendance')
    requests.push(payload)
    if (payload.requestId === 'attempt:1' && failSecondChunkOnce) {
      failSecondChunkOnce = false
      throw new Error('temporary network failure')
    }
    const results = payload.attendance.map((item) => {
      const key = `${payload.requestId}:${item.clientId}`
      const duplicate = saved.has(key)
      saved.add(key)
      return { clientId: item.clientId, success: true, duplicate }
    })
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true, results }),
    }
  }
  const api = apiWithFetch(fetch)
  const marks = Array.from({ length: 101 }, (_, index) => ({
    clientId: `child-${index + 1}`,
    status: 'attended',
  }))

  await assert.rejects(api.recordBulkAttendance(marks, 'lesson-1', '2026-10-02', 'attempt'), /Сервис не ответил/)
  const retried = await api.recordBulkAttendance(marks, 'lesson-1', '2026-10-02', 'attempt')
  assert.equal(retried.success, true)
  assert.equal(retried.results.length, 101)
  assert.equal(retried.results.filter((result) => result.duplicate).length, 100)
  assert.deepEqual(
    requests.map((request) => request.attendance.length),
    [100, 1, 100, 1],
  )
  assert.deepEqual(
    requests.map((request) => request.requestId),
    ['attempt:0', 'attempt:1', 'attempt:0', 'attempt:1'],
  )
  assert.equal(saved.size, 101)
})

test('confirmed saves expose server balances and tolerate absent or malformed optional snapshots', async () => {
  for (const client of [
    { remainingLessons: 1, totalLessons: 2, status: 'Активен' },
    undefined,
    { remainingLessons: -1, totalLessons: 2, status: 'Активен' },
    { remainingLessons: 3, totalLessons: 2, status: 'Активен' },
    { remainingLessons: '1', totalLessons: 2, status: 'Активен' },
    { remainingLessons: 1, totalLessons: 2, status: 'invalid' },
  ]) {
    let calls = 0
    const api = apiWithFetch(async () => {
      calls++
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, results: [{ clientId: 'a', success: true, client }] }),
      }
    })
    const saved = await api.recordBulkAttendance(
      [{ clientId: 'a', status: 'attended' }],
      'lesson',
      '2026-10-04',
      'save',
    )
    assert.equal(saved.success, true)
    assert.equal(calls, 1)
    const expected = client?.remainingLessons === 1 && client?.status === 'Активен' ? client : undefined
    assert.deepEqual(JSON.parse(JSON.stringify(saved.results[0].client ?? null)), expected ?? null)
  }
})

test('duplicate reads share one request and React cleanup does not abort it', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const fetch = async (_url, options) => {
    calls += 1
    assert.equal(options.signal.aborted, false)
    await gate
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => [{ id: 'client-1' }],
    }
  }
  const api = apiWithFetch(fetch)
  const controller = new AbortController()
  const first = api.fetchClients(controller.signal)
  controller.abort()
  const second = api.fetchClients()
  release()

  assert.deepEqual(await first, [{ id: 'client-1' }])
  assert.deepEqual(await second, [{ id: 'client-1' }])
  assert.equal(calls, 1)
})

test('a truncated attendance acknowledgement is not reported as saved', async () => {
  const api = apiWithFetch(async () => ({ ok: true, status: 200, json: async () => ({ success: true, results: [] }) }))
  await assert.rejects(
    api.recordBulkAttendance([{ clientId: 'child-1', status: 'attended' }], 'lesson-1', '2026-10-04', 'request'),
    (error) => error.code === 'INVALID_RESPONSE' && error.status === 502,
  )
})

test('coach bootstrap sends opt-out flag and old-GAS fallback reads only branches and lessons', async () => {
  const actions = []
  const api = apiWithFetch(async (_url, options) => {
    const { action, payload } = JSON.parse(options.body)
    actions.push([action, payload.sheet])
    if (action === 'getBootstrapData') {
      assert.equal(payload.includeCoaches, false)
      return { ok: false, status: 404, json: async () => ({ status: 'error', code: 'NOT_FOUND' }) }
    }
    assert.notEqual(payload.sheet, 'Тренеры')
    return { ok: true, status: 200, json: async () => [{ id: 'row-1' }] }
  })
  const result = await api.fetchBootstrapData(undefined, undefined, false)
  assert.equal(result.coaches.length, 0)
  assert.equal(actions.length, 3) // One compatibility probe + two reads, never a coach-sheet request.
})

test('attendance acknowledgements reject duplicate, foreign and unsuccessful client results', async () => {
  for (const results of [
    [
      { clientId: 'a', success: true },
      { clientId: 'a', success: true },
    ],
    [
      { clientId: 'a', success: true },
      { clientId: 'other', success: true },
    ],
    [
      { clientId: 'a', success: true },
      { clientId: 'b', success: false },
    ],
  ]) {
    const api = apiWithFetch(async () => ({ ok: true, status: 200, json: async () => ({ success: true, results }) }))
    await assert.rejects(
      api.recordBulkAttendance(
        [
          { clientId: 'a', status: 'attended' },
          { clientId: 'b', status: 'absent' },
        ],
        'lesson',
        '2026-10-04',
        'request',
      ),
      (error) => error.code === 'INVALID_RESPONSE',
    )
  }
})

test('a hanging save times out without automatic resend or false success', async () => {
  let expire
  let calls = 0
  let cleared = false
  const api = apiWithFetch(
    (_url, options) => {
      calls++
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
      })
    },
    {
      setTimeout: (callback, milliseconds) => {
        assert.equal(milliseconds, 45_000)
        expire = callback
        return 1
      },
      clearTimeout: () => {
        cleared = true
      },
    },
  )
  const saving = api.recordBulkAttendance(
    [{ clientId: 'child-1', status: 'attended' }],
    'lesson-1',
    '2026-10-04',
    'same-attempt',
  )
  expire()
  await assert.rejects(saving, (error) => error.status === 503)
  assert.equal(calls, 1)
  assert.equal(cleared, true)
})

test('roster with invalid marks or missing data is rejected before rendering', async () => {
  const api = apiWithFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ lessonId: 'lesson-1', date: '2026-10-04', clients: [null] }),
  }))
  await assert.rejects(api.getLessonRoster('lesson-1', '2026-10-04'), (error) => error.code === 'INVALID_RESPONSE')
})

test('session service failure is not treated as logged out; only 401 expires it', async () => {
  const offline = apiWithFetch(async () => ({ ok: false, status: 503, json: async () => ({ message: 'unavailable' }) }))
  await assert.rejects(offline.session(), (error) => error.status === 503)
  const expired = apiWithFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }))
  assert.deepEqual(JSON.parse(JSON.stringify(await expired.session())), { authenticated: false, user: null })
})

test('fresh reads do not join pre-mutation or previous-session requests', async () => {
  let reads = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const api = apiWithFetch(async (_url, options) => {
    const { action } = JSON.parse(options.body)
    if (action === 'getSheet') {
      const read = ++reads
      if (read === 1) await gate
      return { ok: true, status: 200, json: async () => [{ id: `client-${read}` }] }
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) }
  })
  const before = api.fetchClients()
  await api.updateClient('child-1', { status: 'Пауза' })
  const after = await api.fetchClients()
  assert.equal(after[0].id, 'client-2')
  api.clearPrivateState()
  assert.equal((await api.fetchClients())[0].id, 'client-3')
  release()
  await before
})

test('failure of a later chunk retains unknown outcome even on a business rejection', async () => {
  const api = apiWithFetch(async (_url, options) => {
    const { payload } = JSON.parse(options.body)
    if (payload.requestId === 'attempt:1') return { ok: false, status: 409, json: async () => ({ code: 'CONFLICT' }) }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        results: payload.attendance.map((item) => ({ clientId: item.clientId, success: true })),
      }),
    }
  })
  const marks = Array.from({ length: 101 }, (_, i) => ({ clientId: `child-${i}`, status: 'attended' }))
  await assert.rejects(
    api.recordBulkAttendance(marks, 'lesson-1', '2026-10-04', 'attempt'),
    (error) => error.status === 409 && error.attendanceOutcomeUnknown === true,
  )
})
