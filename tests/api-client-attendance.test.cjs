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
    fetch: (url, options) => {
      // An accepted form result acknowledges delivery separately. Model this
      // endpoint independently; mutation-call counters below count CRM writes.
      if (url === '/api/mutation-drafts' && options?.body && JSON.parse(options.body).mode === 'acknowledge')
        return Promise.resolve(new Response(JSON.stringify({ success: true, confirmed: true })))
      return fetch(url, options)
    },
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

test('cloud receipt limit comes from the same-session server and is checked before reading a file', async () => {
  const api = apiWithFetch(
    async () =>
      new Response('[]', {
        headers: {
          'x-crm-backend': 'postgres',
          'x-crm-receipt-max-bytes': String(3 * 1024 * 1024),
        },
      }),
  )
  await api.fetchUsers()
  assert.equal(api.getReceiptMaxBytes(), 3 * 1024 * 1024)
  await assert.rejects(
    api.uploadReceipt('fictional-client', { size: 3 * 1024 * 1024 + 1, type: 'image/png' }, 0),
    (error) => error.status === 413,
  )
  api.clearPrivateState()
  assert.equal(api.getReceiptMaxBytes(), 5 * 1024 * 1024)
})
test('disabled receipts prevent encoding/upload/inbox calls and reset between sessions', async () => {
  let calls = 0
  const api = apiWithFetch(async () => {
    calls++
    return new Response('[]', { headers: { 'x-crm-backend': 'postgres', 'x-crm-receipt-max-bytes': '0' } })
  })
  await api.fetchUsers()
  assert.equal(api.isReceiptsEnabled(), false)
  await assert.rejects(
    api.uploadReceipt('fictional-client', { size: 1, type: 'image/png' }, 0),
    (error) => error.status === 409 && error.code === 'FEATURE_DISABLED',
  )
  await assert.rejects(api.receiptAttempts('fictional-client'), (error) => error.code === 'FEATURE_DISABLED')
  await assert.rejects(
    api.receiptRecoveryPost('fictional-client', { requestId: 'old-attempt' }),
    (error) => error.code === 'FEATURE_DISABLED',
  )
  assert.equal(calls, 1)
  api.clearPrivateState()
  assert.equal(api.isReceiptsEnabled(), true)
})
test('malformed server receipt limits fail closed instead of promising an unsupported upload', async () => {
  const api = apiWithFetch(
    async () =>
      new Response('[]', {
        headers: {
          'x-crm-backend': 'postgres',
          'x-crm-receipt-max-bytes': '999999999',
        },
      }),
  )
  await assert.rejects(api.fetchUsers(), (error) => error.status === 502)
})

test('PostgreSQL account retries reuse the original key after a lost response', async () => {
  const requests = []
  let lost = true
  const api = apiWithFetch(async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.action === 'getUsers') return new Response('[]', { headers: { 'x-crm-backend': 'postgres' } })
    if (body.mode === 'acknowledge') return new Response(JSON.stringify({ success: true, confirmed: true }))
    requests.push(body)
    if (lost) {
      lost = false
      throw new Error('lost acknowledgement')
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'x-crm-backend': 'postgres' } })
  })
  await api.fetchUsers()
  await assert.rejects(api.resetCoachPassword('test-user', 'temporary-test-password'))
  await api.resetCoachPassword('test-user', 'temporary-test-password')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].payload.requestId, requests[1].payload.requestId)
  await api.resetCoachPassword('test-user', 'another-test-password')
  assert.notEqual(requests[1].payload.requestId, requests[2].payload.requestId)
})

test('changed account input cannot silently replace an unconfirmed PostgreSQL attempt', async () => {
  let writes = 0
  const api = apiWithFetch(async (_url, options) => {
    if (JSON.parse(options.body).action === 'getUsers')
      return new Response('[]', { headers: { 'x-crm-backend': 'postgres' } })
    writes++
    throw new Error('network unavailable')
  })
  await api.fetchUsers()
  await assert.rejects(api.assignUserBranch('test-user', 'first-branch'))
  await assert.rejects(api.assignUserBranch('test-user', 'different-branch'), (error) => error.status === 409)
  assert.equal(writes, 1)
})

test('an HTTP timeout does not discard an account mutation key or allow changed retry data', async () => {
  const writes = []
  const api = apiWithFetch(async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.action === 'getUsers') return new Response('[]', { headers: { 'x-crm-backend': 'postgres' } })
    writes.push(body)
    if (writes.length === 1)
      return new Response(JSON.stringify({ code: 'TIMEOUT', message: 'Acknowledgement timed out' }), { status: 408 })
    return new Response(JSON.stringify({ success: true }))
  })
  await api.fetchUsers()
  await assert.rejects(api.resetCoachPassword('test-user', 'original-test-password'))
  await assert.rejects(api.resetCoachPassword('test-user', 'changed-test-password'), (error) => error.status === 409)
  await api.resetCoachPassword('test-user', 'original-test-password')
  assert.equal(writes.length, 2)
  assert.equal(writes[0].payload.requestId, writes[1].payload.requestId)
})

test('simultaneous account clicks share one PostgreSQL mutation and its explicit key', async () => {
  let writes = 0,
    release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const api = apiWithFetch(async (_url, options) => {
    if (JSON.parse(options.body).action === 'getUsers')
      return new Response('[]', { headers: { 'x-crm-backend': 'postgres' } })
    writes++
    await gate
    return new Response(JSON.stringify({ success: true }))
  })
  await api.fetchUsers()
  const first = api.revokeUserSessions('test-user'),
    second = api.revokeUserSessions('test-user')
  assert.equal(writes, 1)
  release()
  await Promise.all([first, second])
})

test('unconfirmed success bodies retain the account attempt while logout clears private attempt data', async () => {
  const requests = []
  let confirmed = false
  const api = apiWithFetch(async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.action === 'getUsers') return new Response('[]', { headers: { 'x-crm-backend': 'postgres' } })
    requests.push(body)
    return new Response(JSON.stringify({ success: confirmed }))
  })
  await api.fetchUsers()
  await assert.rejects(api.deactivateUser('test-user'))
  confirmed = true
  await api.deactivateUser('test-user')
  assert.equal(requests[0].payload.requestId, requests[1].payload.requestId)
  confirmed = false
  await assert.rejects(api.resetCoachPassword('test-user', 'first-test-password'))
  api.clearPrivateState()
  await api.fetchUsers()
  confirmed = true
  await api.resetCoachPassword('test-user', 'different-test-password')
  assert.notEqual(requests[2].payload.requestId, requests[3].payload.requestId)
})

const accountingSnapshot = {
  remainingLessons: 4,
  totalLessons: 4,
  paidAmount: 5500,
  paymentBalance: 0,
  category: 'плавание',
  lessonsPerWeek: 1,
  status: 'Активен',
}

test('catalogue creation retains its key and rejects changed data after a lost response', async () => {
  const requests = []
  let lost = true
  const api = apiWithFetch(async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.action === 'getUsers') return new Response('[]', { headers: { 'x-crm-backend': 'postgres' } })
    requests.push(body)
    if (lost) {
      lost = false
      throw new Error('lost acknowledgement')
    }
    return new Response(JSON.stringify({ id: 'confirmed-id', name: 'Test', branchId: 'test-branch' }))
  })
  await api.fetchUsers()
  const input = { name: 'Test', branchId: 'test-branch' }
  await assert.rejects(api.createCoach(input))
  await assert.rejects(api.createCoach({ ...input, name: 'Changed' }), (error) => error.status === 409)
  await api.createCoach(input)
  assert.equal(requests[0].payload.requestId, requests[1].payload.requestId)
  assert.equal(requests.length, 2)
})

test('a refreshed version cannot change the original unknown client-edit attempt', async () => {
  const requests = []
  const api = apiWithFetch(async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.action === 'getUsers') return new Response('[]', { headers: { 'x-crm-backend': 'postgres' } })
    requests.push(body)
    if (requests.length === 1) throw new Error('lost acknowledgement')
    return new Response(JSON.stringify({ success: true }))
  })
  await api.fetchUsers()
  await assert.rejects(api.updateClient('test-client', { childName: 'New', expectedVersion: 1 }))
  await api.updateClient('test-client', { childName: 'New', expectedVersion: 2 })
  assert.equal(requests[0].payload.requestId, requests[1].payload.requestId)
  assert.equal(requests[1].payload.expectedVersion, 1)
})

test('PostgreSQL client creation never forwards form-computed subscription credits', async () => {
  let sent
  const api = apiWithFetch(async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.action === 'getUsers') return new Response('[]', { headers: { 'x-crm-backend': 'postgres' } })
    if (body.mode === 'acknowledge') return new Response(JSON.stringify({ success: true, confirmed: true }))
    sent = body.payload
    return new Response(JSON.stringify({ id: 'created-id' }))
  })
  await api.fetchUsers()
  await api.createClient(
    { childName: 'Test', paidAmount: 0, subscription: { remainingLessons: 4, totalLessons: 4 } },
    'original-key',
  )
  assert.equal('subscription' in sent, false)
  assert.equal(sent.paidAmount, 0)
  assert.equal(sent.requestId, 'original-key')
})

test('recovery metadata rejects malformed replies rather than claiming an empty inbox', async () => {
  const api = apiWithFetch(
    async () =>
      new Response(
        JSON.stringify({
          items: [{ requestId: 'key', action: 'createClient', confirmed: 'yes', createdAt: '2026' }],
          hasMore: false,
        }),
      ),
  )
  await assert.rejects(api.mutationDrafts(), /незавершённые попытки/)
  await assert.rejects(api.resolveMutationDraft('original-key', 'recover'), /не подтверждён/)
})
test('receipt recovery rejects foreign metadata and duplicate attempt IDs', async () => {
  const attempt = {
    requestId: 'original-key',
    resumable: false,
    createdAt: '2026-10-08',
    metadata: {
      clientId: 'foreign',
      expectedReceiptVersion: 0,
      fileName: 'Test.png',
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      sizeBytes: 100,
    },
  }
  let attempts = [attempt]
  const api = apiWithFetch(async () => new Response(JSON.stringify({ attempts })))
  await assert.rejects(api.receiptAttempts('own-client'), /незавершённые загрузки/)
  attempts = [
    { ...attempt, metadata: null },
    { ...attempt, metadata: null },
  ]
  await assert.rejects(api.receiptAttempts('own-client'), /незавершённые загрузки/)
})

test('client creation sends the explicit retry key and rejects an unconfirmed success body', async () => {
  const requests = []
  let response = {}
  const api = apiWithFetch(async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return { ok: true, status: 200, json: async () => response }
  })
  const payload = { childName: 'Anna', paidAmount: 5500 }
  await assert.rejects(api.createClient(payload, 'stable-creation'), (error) => error.code === 'INVALID_RESPONSE')
  response = { id: 'confirmed-client' }
  assert.equal((await api.createClient(payload, 'stable-creation')).id, 'confirmed-client')
  assert.deepEqual(requests[0], requests[1])
  assert.equal(requests[1].payload.requestId, 'stable-creation')
})
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
  await assert.rejects(before, (error) => error.code === 'STALE_CONTEXT')
})

test('a later 4xx cannot discard a previously unknown account mutation key', async () => {
  const requests = []
  const api = apiWithFetch(async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.action === 'getUsers') return new Response('[]', { headers: { 'x-crm-backend': 'postgres' } })
    requests.push(body)
    if (requests.length === 1) throw Error('Fictional lost response')
    if (requests.length === 2)
      return new Response(JSON.stringify({ code: 'CONFLICT', message: 'Fictional conflict' }), { status: 409 })
    return new Response(JSON.stringify({ success: true }))
  })
  await api.fetchUsers()
  await assert.rejects(api.assignUserBranch('coach', 'original'))
  await assert.rejects(api.assignUserBranch('coach', 'original'))
  await assert.rejects(api.assignUserBranch('coach', 'different'), (error) => error.status === 409)
  await api.assignUserBranch('coach', 'original')
  assert.equal(requests.length, 3)
  assert.ok(requests.every((row) => row.payload.requestId === requests[0].payload.requestId))
})

test('native attendance keeps one exact key and versions through prepare, write and acknowledgement', async () => {
  const requests = []
  const api = apiWithFetch(async (_url, options) => {
    const data = JSON.parse(options.body)
    requests.push(data)
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'x-crm-backend' ? 'postgres' : null) },
      json: async () =>
        data.action === 'recordBulkAttendance'
          ? { success: true, results: [{ clientId: 'child-1', success: true }] }
          : data.action === 'getUsers'
            ? []
            : { success: true },
    }
  })
  // Discover the native mode through the normal response contract.
  await api.fetchUsers()
  requests.length = 0
  await api.recordBulkAttendance(
    [{ clientId: 'child-1', status: 'absent', expectedVersion: 7 }],
    'lesson-1',
    '2026-10-07',
    'same-key',
    { expectedLessonVersion: 3 },
  )
  assert.deepEqual(
    requests.map((request) => request.action),
    ['prepareAttendance', 'recordBulkAttendance', 'acknowledgeAttendance'],
  )
  assert.ok(requests.every((request) => request.payload.requestId === 'same-key'))
  assert.equal(requests[1].payload.attendance[0].expectedVersion, 7)
  assert.equal(requests[1].payload.expectedLessonVersion, 3)
})
test('native attendance refuses 101 marks before sending any partial transaction', async () => {
  let calls = 0
  const api = apiWithFetch(async () => {
    calls++
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'x-crm-backend' ? 'postgres' : null) },
      json: async () => [],
    }
  })
  await api.fetchUsers()
  calls = 0
  await assert.rejects(
    api.recordBulkAttendance(
      Array.from({ length: 101 }, (_, index) => ({
        clientId: 'child-' + index,
        status: 'attended',
        expectedVersion: 0,
      })),
      'lesson-1',
      '2026-10-07',
      'key',
      { expectedLessonVersion: 1 },
    ),
    (error) => error.status === 400,
  )
  assert.equal(calls, 0)
})
test('lesson cancellation invalidates an in-flight native schedule read', { timeout: 2000 }, async () => {
  let reads = 0,
    release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const api = apiWithFetch(async (_url, options) => {
    const { action } = JSON.parse(options.body)
    if (action === 'getUsers')
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'x-crm-backend' ? 'postgres' : null) },
        json: async () => [],
      }
    if (action === 'getSchedule') {
      const version = ++reads
      if (version === 1) await gate
      return { ok: true, status: 200, json: async () => ({ items: [{ id: 'lesson-' + version }] }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) }
  })
  await api.fetchUsers()
  const stale = api.fetchSchedule('2030-10-07', '2030-10-13')
  try {
    await api.changeLesson('cancelLesson', 'lesson-1', { expectedVersion: 1, reason: 'Test' })
    assert.equal((await api.fetchSchedule('2030-10-07', '2030-10-13'))[0].id, 'lesson-2')
  } finally {
    release()
    await stale
  }
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
