const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function authStoreWith(apiClient) {
  const root = path.resolve(__dirname, '..')
  function load(relative) {
    const exports = {}
    const source = fs.readFileSync(path.join(root, relative), 'utf8')
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText
    vm.runInNewContext(compiled, {
      exports,
      require(name) {
        if (name === '@/lib/api-client') return { apiClient }
        if (name === './models/Auth') return load('store/models/Auth.ts')
        return require(name)
      },
    })
    return exports
  }
  return load('store/AuthStore.ts').AuthStore.create({})
}

const coach = { id: 'coach-1', username: 'coach', role: 'coach', branchId: 'branch-1' }

function rootStoreWith(apiClient) {
  const { types, getType } = require('mobx-state-tree')
  const root = path.resolve(__dirname, '..')
  const exports = {}
  class ApiError extends Error {
    constructor(status, data) {
      super(data.message)
      this.status = status
    }
  }
  const models = {}
  for (const name of ['Branch', 'Coach', 'Lesson']) {
    const result = {}
    const compiled = ts.transpileModule(fs.readFileSync(path.join(root, `store/models/${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText
    vm.runInNewContext(compiled, { exports: result, require })
    Object.assign(models, result)
  }
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, 'store/RootStore.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(compiled, {
    exports,
    AbortController,
    require(name) {
      if (name === '@/lib/api-client') return { apiClient, ApiError }
      if (name === '@/store/models') return models
      if (name === '@/lib/normalizers') return { normalizeLesson: (value) => value }
      if (name === './AuthStore') return { AuthStore: getType(authStoreWith(apiClient)) }
      if (name === './ClientStore') return { ClientStore: types.model('TestClientStore', {}) }
      return require(name)
    },
  })
  return exports.RootStore.create({ authStore: { user: coach, isAuthenticated: true, isInitialized: true } })
}

const bootstrap = () => ({
  branches: [{ id: 'branch-1', name: 'Pool' }],
  coaches: [],
  lessons: [{ id: 'lesson-1', branchId: 'branch-1', title: 'Swimming', time: '17:00' }],
})

test('coach bootstrap has no admin prefetch, retains last good schedule on outage, and supports retry', async () => {
  let fail = false
  let calls = 0
  const root = rootStoreWith({
    clearPrivateState() {},
    fetchBootstrapData: async (_signal, _branch, includeCoaches) => {
      assert.equal(includeCoaches, false, 'coach workspace does not load coach cards')
      calls++
      if (fail) throw new Error('offline')
      return bootstrap()
    },
    fetchClientsPage: () => {
      assert.fail('admin prefetch in coach workspace')
    },
    getDashboardSummary: () => {
      assert.fail('admin summary in coach workspace')
    },
  })
  await root.initialize()
  assert.equal(calls, 1)
  assert.equal(root.currentBranch.id, 'branch-1')
  assert.equal(root.hasLoadedData, true)
  root.setScreen('Финансы')
  assert.equal(root.currentScreen, 'Дашборд')
  fail = true
  await root.initialize(true)
  assert.equal(root.isLoading, false)
  assert.ok(root.error)
  assert.equal(root.hasLoadedData, true)
  assert.equal(root.lessons[0].id, 'lesson-1')
  fail = false
  await root.initialize(true)
  assert.equal(root.error, null)
  assert.equal(root.isLoading, false)
})

test('wrong branch is not used as fallback and duplicate coach refreshes send only one request', async () => {
  let release
  let calls = 0
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const root = rootStoreWith({
    clearPrivateState() {},
    fetchBootstrapData: async () => {
      calls++
      await gate
      return { ...bootstrap(), branches: [{ id: 'other-branch', name: 'Other' }] }
    },
  })
  const first = root.initialize()
  await root.initialize(true)
  release()
  await first
  assert.equal(calls, 1)
  assert.equal(root.hasLoadedData, false)
  assert.equal(root.branches.length, 0)
  assert.equal(root.lessons.length, 0)
  assert.equal(root.isLoading, false)
  assert.ok(root.error)
  assert.equal(root.requiresAccessRefresh, true)
})

test('a forced access check gates the old workspace until the response is verified', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const auth = authStoreWith({
    clearPrivateState() {},
    login: async () => ({ user: coach }),
    session: async () => {
      await gate
      return { authenticated: true, user: coach }
    },
  })
  await auth.login('coach', 'password')
  const pending = auth.init(true)
  assert.equal(auth.isInitialized, false)
  release()
  await pending
  assert.equal(auth.isInitialized, true)
  assert.equal(auth.sessionError, null)
})

test('a delayed bootstrap from an earlier session cannot populate the next account', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const root = rootStoreWith({
    clearPrivateState() {},
    login: async () => ({ user: { ...coach, id: 'coach-2' } }),
    fetchBootstrapData: async () => {
      await gate
      return bootstrap()
    },
  })
  const pending = root.initialize()
  await root.authStore.login('coach-2', 'password')
  release()
  await pending
  assert.equal(root.hasLoadedData, false)
  assert.equal(root.lessons.length, 0)
  assert.equal(root.authStore.user.id, 'coach-2')
})

test('coach login uses one remote authorization and clears old private state', async () => {
  let logins = 0
  let clears = 0
  const auth = authStoreWith({
    login: async () => {
      logins++
      return { user: coach }
    },
    session: async () => {
      throw new Error('unnecessary probe')
    },
    clearPrivateState: () => {
      clears++
    },
  })
  await auth.login('coach', 'password')
  assert.equal(auth.isAuthenticated, true)
  assert.equal(auth.isCoach, true)
  assert.equal(auth.isAdmin, false)
  assert.equal(logins, 1)
  assert.equal(clears, 1)
})

test('service outage shows session recovery, retry succeeds, invalid session fails closed', async () => {
  let response = 'offline'
  const auth = authStoreWith({
    clearPrivateState() {},
    session: async () => {
      if (response === 'offline') throw new Error('network')
      return response === 'valid' ? { authenticated: true, user: coach } : { authenticated: false, user: null }
    },
  })
  await auth.init()
  assert.equal(auth.isInitialized, true)
  assert.equal(auth.isLoading, false)
  assert.equal(auth.isAuthenticated, false)
  assert.ok(auth.sessionError)
  response = 'valid'
  await auth.init(true)
  assert.equal(auth.isAuthenticated, true)
  assert.equal(auth.sessionError, null)
  response = 'expired'
  await auth.init(true)
  assert.equal(auth.isAuthenticated, false)
  assert.equal(auth.user, null)
})

test('double login is not sent twice and failed logout does not pretend the cookie was cleared', async () => {
  let release
  let logins = 0
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const auth = authStoreWith({
    clearPrivateState() {},
    login: async () => {
      logins++
      await gate
      return { user: coach }
    },
    logout: async () => {
      throw new Error('network')
    },
  })
  const first = auth.login('coach', 'password')
  await auth.login('coach', 'password')
  release()
  await first
  assert.equal(logins, 1)
  await auth.logout()
  assert.equal(auth.isLoading, false)
  assert.ok(auth.sessionError)
})

test('coach workspace has only two sections and no polling, finance or admin warmup', () => {
  const root = path.resolve(__dirname, '..')
  const workspace = fs.readFileSync(path.join(root, 'components/CoachWorkspace.tsx'), 'utf8')
  const page = fs.readFileSync(path.join(root, 'app/page.tsx'), 'utf8')
  const route = fs.readFileSync(path.join(root, 'app/api/[[...path]]/route.ts'), 'utf8')
  assert.match(workspace, /\['Дашборд', 'Расписание'\]/)
  assert.doesNotMatch(workspace, /getFinanceSummary|fetchClientsPage|setInterval|setTimeout|localStorage/)
  assert.match(page, /if \(store.authStore.isCoach\) return <CoachWorkspace/)
  assert.doesNotMatch(route, /crmReadCache\.getOrLoad/)
  assert.match(route, /await dispatchCrmAction\(\{ action, payload, user \}\)/)
  assert.match(page, /if \(sessionError\)/)
  const rootStore = fs.readFileSync(path.join(root, 'store/RootStore.ts'), 'utf8')
  assert.doesNotMatch(rootStore, /\.fetchClientsPage|\.getDashboardSummary/)
  for (const name of ['app/error.tsx', 'app/global-error.tsx', 'components/WorkspaceBoundary.tsx']) {
    const fallback = fs.readFileSync(path.join(root, name), 'utf8')
    assert.doesNotMatch(fallback, /error\.message|error\.stack|localStorage/)
  }
})
