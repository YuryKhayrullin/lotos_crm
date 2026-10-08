const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function loadServerModule(file) {
  const exports = {}
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(compiled, { exports, Buffer, require: (name) => (name === 'server-only' ? {} : require(name)) })
  return exports
}

const passwords = loadServerModule('lib/server/passwords.ts')

function registrationRoute({
  result = { status: 'success', pending: true },
  limited = false,
  limiterFailure = false,
  gasFailure = false,
} = {}) {
  const calls = []
  const exports = {}
  class RateLimitError extends Error {}
  const compiled = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '..', 'app/api/[[...path]]/route.ts'), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    },
  ).outputText
  vm.runInNewContext(compiled, {
    exports,
    Buffer,
    process: { env: { CRM_BACKEND: 'gas' } },
    require(name) {
      if (name === 'next/server')
        return {
          NextResponse: class extends Response {
            static json(data, options) {
              return new Response(JSON.stringify(data), options)
            }
          },
        }
      if (name === '@/lib/server/passwords') return passwords
      if (name === '@/lib/server/auth-user') return require('../.test-dist/server/auth-user.js')
      if (name === '@/lib/server/api-errors')
        return { codeForHttpStatus: (status) => (status === 400 ? 'VALIDATION' : 'SERVICE_UNAVAILABLE') }
      if (name === '@/lib/server/policy') return { PolicyError: class extends Error {} }
      if (name === '@/lib/server/gas')
        return {
          GasError: class extends Error {},
          callGas: async (request) => {
            calls.push(request)
            if (gasFailure) throw new Error('private upstream details')
            return result
          },
        }
      if (name === '@/lib/server/crm-router') return { UPLOAD_ACTIONS: new Set() }
      if (name === '@/lib/server/logger') return { serverLog() {} }
      if (name === '@/lib/server/request')
        return {
          rejectCrossOrigin: (request) =>
            request.headers.get('origin') === 'http://localhost:3001' ? null : new Response('{}', { status: 403 }),
        }
      if (name === '@/lib/server/session')
        return {
          SessionError: class extends Error {},
          createSession: () => assert.fail('registration cannot create any session'),
          getSession: () => assert.fail('registration must not require or elevate an existing session'),
          clearSession: () => assert.fail('registration must not alter an existing session'),
        }
      if (name === '@/lib/server/login-rate-limit')
        return {
          LoginRateLimitUnavailableError: RateLimitError,
          getLoginRateLimiter: () => ({
            check: async () => ({ pairKey: 'login' }),
            resetSuccessfulPair: async () => {},
          }),
          getRegistrationRateLimiter: () => ({
            check: async () => {
              if (limiterFailure) throw new RateLimitError()
              return limited ? null : { pairKey: 'key' }
            },
          }),
        }
      throw new Error('Unexpected dependency: ' + name)
    },
  })
  return {
    calls,
    request: (body, origin = 'http://localhost:3001') =>
      exports.POST(
        new Request('http://localhost:3001/api/auth/register', {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ path: ['auth', 'register'] }) },
      ),
    get: () =>
      exports.GET(new Request('http://localhost:3001/api/auth/register'), {
        params: Promise.resolve({ path: ['auth', 'register'] }),
      }),
    login: (body) =>
      exports.POST(
        new Request('http://localhost:3001/api/auth/login', {
          method: 'POST',
          headers: { Origin: 'http://localhost:3001', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ path: ['auth', 'login'] }) },
      ),
  }
}

const credentials = { username: ' Coach.New ', password: 'strong-password', requestId: 'register-1' }

test('a pending coach with the correct password cannot obtain a BFF session before approval', async () => {
  const passwordHash = await passwords.hashPassword(credentials.password)
  const route = registrationRoute({
    result: {
      user: {
        id: 'new-user',
        username: 'coach.new',
        passwordHash,
        role: '2',
        branchId: null,
        status: 'Ожидает подтверждения',
      },
    },
  })
  const response = await route.login(credentials)
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(route.calls.length, 1)
  assert.equal(route.calls[0].action, 'getAuthUser')
})

test('public registration hashes the password, strips authority fields and never issues or clears a session', async () => {
  const route = registrationRoute()
  const response = await route.request({
    ...credentials,
    role: 'admin',
    branchId: 'other-branch',
    status: 'Активен',
    passwordHash: 'forged',
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { status: 'success', pending: true })
  assert.equal(route.calls.length, 1)
  const request = route.calls[0]
  assert.equal(request.action, 'registerCoach')
  assert.equal(request.auth, undefined)
  assert.deepEqual(Object.keys(request.payload).sort(), ['passwordHash', 'requestId', 'username'])
  assert.equal(request.payload.username, 'coach.new')
  assert.equal(request.payload.requestId, 'register-1')
  assert(passwords.isScryptPasswordHash(request.payload.passwordHash))
  assert(await passwords.verifyPassword(credentials.password, request.payload.passwordHash))
  assert.equal(JSON.stringify(request).includes(credentials.password), false)
})

test('invalid registration payloads and cross-origin POSTs never reach GAS', async () => {
  const route = registrationRoute()
  for (const body of [
    null,
    [],
    { ...credentials, username: 'x' },
    { ...credentials, username: '<script>' },
    { ...credentials, password: 'short' },
    { ...credentials, password: 'x'.repeat(201) },
    { ...credentials, requestId: '' },
  ]) {
    assert.equal((await route.request(body)).status, 400)
  }
  assert.equal((await route.request(credentials, 'https://evil.example')).status, 403)
  assert.equal((await route.get()).status, 405)
  assert.equal(route.calls.length, 0)
})

test('registration fails closed when rate limits are hit or their shared store is unavailable', async () => {
  for (const [options, status] of [
    [{ limited: true }, 429],
    [{ limiterFailure: true }, 503],
  ]) {
    const route = registrationRoute(options)
    assert.equal((await route.request(credentials)).status, status)
    assert.equal(route.calls.length, 0)
  }
})

test('malformed upstream registration acknowledgement and failures are not reported as success or leaked', async () => {
  for (const options of [
    { result: null },
    { result: {} },
    { result: { status: 'success', pending: false } },
    { gasFailure: true },
  ]) {
    const route = registrationRoute(options)
    const response = await route.request(credentials)
    assert(response.status >= 500)
    const body = await response.text()
    assert.doesNotMatch(body, /private upstream details|strong-password/)
    assert.equal(response.headers.get('set-cookie'), null)
  }
})
