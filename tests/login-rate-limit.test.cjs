const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function loadRateLimitModule(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib/server/login-rate-limit.ts'), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const exports = {}
  const context = {
    exports,
    process,
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    require: (name) => (name === 'server-only' ? {} : require(name)),
    ...overrides,
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

test('registration quotas are isolated from login and normalized usernames share a counter', async () => {
  const store = new FakeRateLimitStore()
  const registration = rateLimit.createLoginRateLimiter(store, { namespace: 'registration', pairLimit: 1, ipLimit: 2 })
  const login = rateLimit.createLoginRateLimiter(store, { pairLimit: 1, ipLimit: 1 })
  assert(await registration.check('203.0.113.9', ' Coach.New '))
  assert.equal(await registration.check('203.0.113.9', 'coach.new'), null)
  assert.equal(await registration.check('203.0.113.9', 'another.coach'), null)
  assert(await login.check('203.0.113.9', 'coach.new'))
})

test('production registration fails closed without a shared limiter and bounds a hanging store request', async () => {
  const missing = loadRateLimitModule({ process: { env: { NODE_ENV: 'production' } } })
  assert.throws(() => missing.getRegistrationRateLimiter(), /ограничений входа недоступно/)
  let requests = 0
  let cancelled = 0
  const hanging = loadRateLimitModule({
    process: {
      env: {
        NODE_ENV: 'production',
        UPSTASH_REDIS_REST_URL: 'https://test.invalid',
        UPSTASH_REDIS_REST_TOKEN: 'test-token',
      },
    },
    setTimeout: (callback, milliseconds) => {
      assert.equal(milliseconds, 5_000)
      queueMicrotask(callback)
      return 1
    },
    clearTimeout() {},
    fetch: async (_url, options) => {
      requests++
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            cancelled++
            reject(new Error('timeout'))
          },
          { once: true },
        )
      })
    },
  })
  await assert.rejects(
    hanging.getRegistrationRateLimiter().check('203.0.113.9', 'new.coach'),
    /ограничений входа недоступно/,
  )
  assert.equal(requests, 2)
  assert.equal(cancelled, 2)
})
