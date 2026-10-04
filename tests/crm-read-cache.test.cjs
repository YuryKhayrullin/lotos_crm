const test = require('node:test')
const assert = require('node:assert/strict')
const { createCrmReadCache } = require('../.test-dist/server/crm-read-cache.js')

const user = { id: 'user-1', username: 'admin', role: 'admin', branchId: null }

test('CRM read cache serves a fresh private result without a second load', async () => {
  let calls = 0
  let clock = 0
  const cache = createCrmReadCache({ freshMs: 100, staleMs: 1_000, now: () => clock })
  const loader = async () => ({ calls: ++calls })

  const first = await cache.getOrLoad('getClients', { page: 1 }, user, loader)
  clock = 50
  const second = await cache.getOrLoad('getClients', { page: 1 }, user, loader)

  assert.equal(first.status, 'MISS')
  assert.equal(second.status, 'HIT')
  assert.deepEqual(second.value, { calls: 1 })
  assert.equal(calls, 1)
})

test('CRM read cache returns stale data immediately and refreshes it in background', async () => {
  let calls = 0
  let clock = 0
  let releaseRefresh
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve
  })
  const cache = createCrmReadCache({ freshMs: 10, staleMs: 1_000, now: () => clock })
  const loader = async () => {
    calls += 1
    if (calls === 2) await refreshGate
    return { calls }
  }

  await cache.getOrLoad('getClients', { page: 1 }, user, loader)
  clock = 20
  const stale = await cache.getOrLoad('getClients', { page: 1 }, user, loader)

  assert.equal(stale.status, 'STALE')
  assert.deepEqual(stale.value, { calls: 1 })
  assert.equal(calls, 2)

  releaseRefresh()
  await new Promise((resolve) => setImmediate(resolve))
  const refreshed = await cache.getOrLoad('getClients', { page: 1 }, user, loader)
  assert.equal(refreshed.status, 'HIT')
  assert.deepEqual(refreshed.value, { calls: 2 })
})

test('CRM read cache separates users and does not repopulate after invalidation', async () => {
  let calls = 0
  const cache = createCrmReadCache({ freshMs: 100, staleMs: 1_000 })
  const loader = async () => ({ calls: ++calls })

  await cache.getOrLoad('getClients', {}, user, loader)
  await cache.getOrLoad('getClients', {}, { ...user, id: 'user-2' }, loader)
  cache.invalidate()
  const afterMutation = await cache.getOrLoad('getClients', {}, user, loader)

  assert.equal(calls, 3)
  assert.equal(afterMutation.status, 'MISS')
  assert.deepEqual(afterMutation.value, { calls: 3 })
})
