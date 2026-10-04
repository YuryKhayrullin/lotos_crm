const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function loadRateLimitModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib/server/login-rate-limit.ts'), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const exports = {}
  const context = {
    exports,
    process,
    fetch,
    require: (name) => (name === 'server-only' ? {} : require(name)),
  }
  vm.createContext(context)
  vm.runInContext(compiled, context)
  return exports
}

const rateLimit = loadRateLimitModule()

class FakeRateLimitStore {
  constructor() {
    this.values = new Map()
    this.removed = []
  }

  async increment(key) {
    const next = (this.values.get(key) || 0) + 1
    this.values.set(key, next)
    return next
  }

  async remove(key) {
    this.removed.push(key)
    this.values.delete(key)
  }
}

test('login rate limiting has independent IP+login and IP limits without raw personal data in keys', async () => {
  const store = new FakeRateLimitStore()
  const limiter = rateLimit.createLoginRateLimiter(store, { pairLimit: 2, ipLimit: 4, windowSeconds: 60 })

  const first = await limiter.check('203.0.113.9', 'coach@example')
  const second = await limiter.check('203.0.113.9', 'coach@example')
  const pairBlocked = await limiter.check('203.0.113.9', 'coach@example')
  const anotherLogin = await limiter.check('203.0.113.9', 'another@example')
  const ipBlocked = await limiter.check('203.0.113.9', 'third@example')

  assert(first)
  assert(second)
  assert.equal(pairBlocked, null)
  assert(anotherLogin)
  assert.equal(ipBlocked, null)
  assert([...store.values.keys()].every((key) => !key.includes('203.0.113.9') && !key.includes('coach@example')))

  await limiter.resetSuccessfulPair(first)
  assert.deepEqual(store.removed, [first.pairKey])
})
