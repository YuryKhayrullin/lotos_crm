const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const exportsObject = {}
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../lib/creation-retry.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText,
  { exports: exportsObject },
)
const { CreationRetry } = exportsObject

test('creation freezes payload and key after a lost reply and suppresses same-tick double clicks', async () => {
  const retry = new CreationRetry()
  let release
  const calls = []
  let keys = 0
  const payload = { childName: 'Anna', paidAmount: 5500, subscription: { lessons: 4 } }
  const send = (value, requestId) => {
    calls.push({ value, requestId })
    return new Promise((_, reject) => {
      release = reject
    })
  }
  const first = retry.submit(
    payload,
    () => 'id-' + ++keys,
    send,
    () => false,
  )
  assert.equal(
    await retry.submit(
      payload,
      () => 'wrong',
      send,
      () => false,
    ),
    undefined,
  )
  payload.paidAmount = 10000
  payload.subscription.lessons = 12
  release(new Error('lost reply'))
  await assert.rejects(first)
  assert.equal(retry.attempt.payload.paidAmount, 5500)
  assert.equal(retry.attempt.payload.subscription.lessons, 4)
  await assert.rejects(
    retry.submit(
      payload,
      () => 'wrong',
      async () => {
        throw new Error('conflict after uncertainty')
      },
      () => true,
    ),
  )
  assert.equal(retry.attempt.requestId, 'id-1')
  assert.equal(
    await retry.submit(
      payload,
      () => 'wrong',
      async (value, key) => {
        assert.equal(value.paidAmount, 5500)
        assert.equal(key, 'id-1')
        return 'confirmed'
      },
      () => false,
    ),
    'confirmed',
  )
  assert.equal(retry.attempt, null)
  assert.equal(retry.running, false)
  assert.equal(keys, 1)
  assert.equal(calls.length, 1)
})

test('a first definitive pre-write rejection permits fixing the form with a new key', async () => {
  const retry = new CreationRetry()
  await assert.rejects(
    retry.submit(
      {},
      () => 'invalid',
      async () => {
        throw new Error('validation')
      },
      () => true,
    ),
  )
  assert.equal(retry.attempt, null)
  await retry.submit(
    { corrected: true },
    () => 'new-key',
    async (_, key) => {
      assert.equal(key, 'new-key')
    },
    () => false,
  )
})
