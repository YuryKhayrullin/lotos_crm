const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// Exercise component event/effect logic without a browser or DOM dependency.
// Effects are committed after render; cleanup and stable dependencies are retained.
function componentHarness(file, exportName, apiClient) {
  const hooks = []
  const effects = []
  const timers = new Map()
  let cursor = 0
  let timerId = 0
  const sameDeps = (left, right) =>
    left && right && left.length === right.length && left.every((v, i) => Object.is(v, right[i]))
  const react = {
    useState(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [
        hooks[index].value,
        (next) => {
          hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next
        },
      ]
    },
    useRef(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect(effect, deps) {
      const index = cursor++
      if (sameDeps(hooks[index]?.deps, deps)) return
      effects.push(() => {
        hooks[index]?.cleanup?.()
        hooks[index] = { deps, cleanup: effect() }
      })
    },
  }
  const store = {
    selectedBranchId: 'branch-1',
    branches: [{ id: 'branch-1', name: 'Pool' }],
    coaches: [],
    branchCoaches: [],
    sortedBranchLessons: [],
    authStore: { isAdmin: true, isCoach: false },
  }
  const exports = {}
  const elements = new Proxy({}, { get: (_target, name) => name })
  const jsx = (type, props) => ({ type, props })
  const source =
    fs.readFileSync(path.join(__dirname, '..', file), 'utf8') +
    (exportName === 'Dashboard' ? '\nexport { Dashboard }\n' : '')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  vm.runInNewContext(compiled, {
    exports,
    AbortController,
    window: {
      confirm: () => true,
      location: { origin: 'http://localhost:3001' },
      setTimeout: (callback) => {
        timers.set(++timerId, callback)
        return timerId
      },
      clearTimeout: (id) => timers.delete(id),
    },
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'mobx-react-lite') return { observer: (component) => component }
      if (name === '@/store/StoreProvider') return { useStore: () => store }
      if (name === '@/store/RootStore') return { getStore: () => store }
      if (name === 'next/dynamic') return { default: () => 'DynamicSection' }
      if (name === 'next/link') return { default: 'Link' }
      if (name === '@/lib/constants/nav') return { nav: [] }
      if (name === '@/lib/branch-selection') return {}
      if (name === '@/lib/formatters') return require('../.test-dist/formatters.js')
      if (name === '@/lib/api-client')
        return { apiClient, createRequestId: () => 'registration-attempt', ApiError: Error }
      if (name === '@/lib/utils/date')
        return { isValidDateOnly: () => true, parseTimeToHHMM: (value) => value, isLessonOnDay: () => true }
      if (name.startsWith('@/components/') || name === 'lucide-react') return elements
      throw new Error('Unexpected dependency: ' + name)
    },
  })
  return {
    store,
    render(props = {}) {
      cursor = 0
      const tree = exports[exportName](props)
      effects.splice(0).forEach((run) => run())
      return tree
    },
    runTimers() {
      const pending = [...timers.values()]
      timers.clear()
      pending.forEach((run) => run())
    },
    unmount() {
      hooks.forEach((hook) => hook?.cleanup?.())
    },
  }
}

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}

function textContent(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textContent).join('')
  return tree && typeof tree === 'object' ? textContent(tree.props?.children) : ''
}
const buttonNamed = (tree, label) =>
  nodes(tree).find((node) => node.type === 'Button' && textContent(node).trim() === label)
const accountBranchPicker = (tree) =>
  nodes(tree).find(
    (node) => node.type === 'Select' && nodes(node).some((child) => child.props['aria-label'] === 'Филиал для anna'),
  )
const pendingAccount = () => ({
  id: 'anna-id',
  username: 'anna',
  role: 'coach',
  branchId: null,
  status: 'Ожидает подтверждения',
  disabledAt: null,
  disabledBy: null,
})

test('coach access pickers use readable labels, null placeholders and nonoverlapping full-width triggers', async () => {
  const account = { ...pendingAccount(), branchId: 'branch-1' }
  const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', { fetchUsers: async () => [account] })
  const coach = {
    id: 'coach-1',
    branchId: 'branch-1',
    userId: '',
    initials: 'КН',
    name: 'Катя Никулина',
    specialty: 'Тренер',
  }
  harness.store.coaches = [coach]
  harness.store.branchCoaches = [coach]
  harness.render()
  await settle()
  const tree = harness.render()
  const pickers = nodes(tree).filter((node) => node.type === 'Select')
  assert.equal(pickers.length, 3)
  assert(pickers.every((node) => Array.isArray(node.props.items)))
  assert(
    nodes(tree)
      .filter((node) => node.type === 'SelectContent')
      .every((node) => node.props.alignItemWithTrigger === false),
  )
  assert(
    nodes(tree)
      .filter((node) => node.type === 'SelectTrigger')
      .every((node) => node.props.className.includes('w-full')),
  )
  const branchPicker = accountBranchPicker(tree)
  const branchValue = nodes(branchPicker).find((node) => node.type === 'SelectValue')
  assert.equal(branchValue.props.children('branch-1'), 'Pool')
  assert.equal(branchValue.props.children(null), 'Выберите филиал')
  const loginPicker = pickers.find((node) => node.props.value === 'anna-id')
  assert.equal(
    nodes(loginPicker)
      .find((node) => node.type === 'SelectValue')
      .props.children('anna-id'),
    'anna',
  )
  const passwordDisclosure = nodes(tree).find((node) => node.type === 'details')
  assert.equal(passwordDisclosure.props.open, undefined)
})

test('one approval click assigns the branch before activating, guards duplicate clicks and refreshes only once', async () => {
  const account = pendingAccount()
  const calls = []
  let reads = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', {
    fetchUsers: async () => {
      reads++
      return [{ ...account }]
    },
    assignUserBranch: async (id, branchId) => {
      calls.push(['branch', id, branchId])
      await gate
      account.branchId = branchId
      return { success: true }
    },
    activateUser: async (id) => {
      calls.push(['activate', id])
      assert.equal(account.branchId, 'branch-1')
      account.status = 'Активен'
      return { success: true }
    },
  })
  harness.render()
  await settle()
  let tree = harness.render()
  assert.equal(accountBranchPicker(tree).props.value, null)
  assert.equal(buttonNamed(tree, 'Подтвердить доступ').props.disabled, true)
  accountBranchPicker(tree).props.onValueChange('branch-1')
  tree = harness.render()
  const approve = buttonNamed(tree, 'Подтвердить доступ')
  assert.equal(approve.props.disabled, false)
  approve.props.onClick()
  approve.props.onClick()
  await settle()
  assert.deepEqual(calls, [['branch', 'anna-id', 'branch-1']])
  release()
  await settle()
  await settle()
  assert.deepEqual(calls, [
    ['branch', 'anna-id', 'branch-1'],
    ['activate', 'anna-id'],
  ])
  assert.equal(reads, 2)
  assert.match(textContent(harness.render()), /Вход разрешён/)
  assert(nodes(harness.render()).some((node) => node.props.role === 'status'))
  assert(!nodes(harness.render()).some((node) => node.props['data-section'] === 'pending-coaches'))
  assert.equal(nodes(harness.render()).filter((node) => node.props['data-trainer-id'] === account.id).length, 1)
  assert.doesNotMatch(textContent(harness.render()), /В этом филиале пока нет тренеров|Для входа она не обязательна/)
})

test('approved accounts render as trainers without a separate coach row or any extra server calls', async () => {
  let reads = 0
  const account = { ...pendingAccount(), status: 'Активен', branchId: 'branch-1' }
  const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', {
    fetchUsers: async () => {
      reads++
      return [account]
    },
  })
  harness.render()
  await settle()
  const tree = harness.render()
  assert.equal(nodes(tree).filter((node) => node.props['data-trainer-id'] === account.id).length, 1)
  assert.match(textContent(tree), /anna.*Вход разрешён.*Pool/)
  assert.doesNotMatch(
    textContent(tree),
    /Для входа она не обязательна|Карточки тренеров|В этом филиале пока нет тренеров/,
  )
  assert(!nodes(tree).some((node) => node.props['data-section'] === 'pending-coaches'))
  const management = nodes(tree).find(
    (node) => node.type === 'details' && textContent(node).startsWith('Управление тренером'),
  )
  assert(management)
  assert.equal(management.props.open, undefined)
  assert(buttonNamed(management, 'Отключить вход'))
  assert.equal(reads, 1)
  assert.equal(harness.store.coaches.length, 0, 'rendering never invents or persists a coach identity')
})

test('explicitly linked trainer profile and login appear once, while unlinked profiles are preserved', async () => {
  const account = { ...pendingAccount(), status: 'Активен', branchId: 'branch-1' }
  const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', { fetchUsers: async () => [account] })
  const linked = {
    id: 'profile-1',
    userId: account.id,
    branchId: 'branch-1',
    name: 'Анна Иванова',
    phone: '+7 999',
    initials: 'АИ',
    specialty: 'Тренер',
  }
  const unlinked = { ...linked, id: 'profile-2', userId: '', name: 'Анна Петрова' }
  harness.store.coaches = [linked, unlinked]
  harness.store.branchCoaches = [linked, unlinked]
  harness.render()
  await settle()
  const tree = harness.render()
  const text = textContent(tree)
  assert.equal(text.split('Анна Иванова').length - 1, 1)
  assert.match(text, /Логин: anna/)
  assert.match(text, /Анна Петрова/)
  assert.equal(nodes(tree).filter((node) => node.props['data-trainer-id'] === account.id).length, 1)
})

test('trainer accounts follow selected branch scope, while unassigned registration remains actionable', async () => {
  const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', {
    fetchUsers: async () => [
      { ...pendingAccount(), status: 'Активен', branchId: 'branch-1' },
      { ...pendingAccount(), id: 'other', username: 'other.coach', status: 'Активен', branchId: 'branch-2' },
      { ...pendingAccount(), id: 'new', username: 'new.coach' },
    ],
  })
  harness.render()
  await settle()
  assert.match(textContent(harness.render()), /anna/)
  assert.doesNotMatch(textContent(harness.render()), /other.coach/)
  assert.match(textContent(harness.render()), /new.coach/)
  harness.store.selectedBranchId = 'branch-2'
  assert.doesNotMatch(textContent(harness.render()), /anna/)
  assert.match(textContent(harness.render()), /other.coach/)
  harness.store.selectedBranchId = ''
  assert.match(textContent(harness.render()), /anna/)
  assert.match(textContent(harness.render()), /other.coach/)
})

test('disabling entry retains the trainer card and offers explicit reactivation', async () => {
  const account = { ...pendingAccount(), status: 'Активен', branchId: 'branch-1' }
  const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', {
    fetchUsers: async () => [{ ...account }],
    deactivateUser: async () => {
      account.status = 'Отключен'
      return { success: true }
    },
    activateUser: async () => {
      account.status = 'Активен'
      return { success: true }
    },
  })
  harness.render()
  await settle()
  buttonNamed(harness.render(), 'Отключить вход').props.onClick()
  await settle()
  await settle()
  assert.match(textContent(harness.render()), /Вход отключён/)
  assert(!nodes(harness.render()).some((node) => node.props['data-section'] === 'pending-coaches'))
  buttonNamed(harness.render(), 'Разрешить вход').props.onClick()
  await settle()
  await settle()
  assert.match(textContent(harness.render()), /Вход разрешён/)
})

test('failed branch assignment never activates and a failed activation remains pending with retry', async () => {
  for (const failAt of ['branch', 'activate']) {
    const account = pendingAccount()
    let activations = 0
    let failOnce = true
    const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', {
      fetchUsers: async () => [{ ...account }],
      assignUserBranch: async (_id, branchId) => {
        if (failOnce && failAt === 'branch') {
          failOnce = false
          throw new Error('unavailable')
        }
        account.branchId = branchId
        return { success: true }
      },
      activateUser: async () => {
        activations++
        if (failOnce && failAt === 'activate') {
          failOnce = false
          throw new Error('unavailable')
        }
        account.status = 'Активен'
        return { success: true }
      },
    })
    harness.render()
    await settle()
    accountBranchPicker(harness.render()).props.onValueChange('branch-1')
    buttonNamed(harness.render(), 'Подтвердить доступ').props.onClick()
    await settle()
    await settle()
    assert.equal(activations, failAt === 'branch' ? 0 : 1)
    assert.equal(account.status, 'Ожидает подтверждения')
    assert(nodes(harness.render()).some((node) => node.props.role === 'alert'))
    assert.doesNotMatch(textContent(harness.render()), /Вход разрешён/)
    buttonNamed(harness.render(), 'Подтвердить доступ').props.onClick()
    await settle()
    await settle()
    assert.equal(account.status, 'Активен')
  }
})

test('a missing branch or unconfirmed assignment cannot approve access', async () => {
  const account = pendingAccount()
  const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', {
    fetchUsers: async () => [account],
    assignUserBranch: async () => ({ success: false }),
    activateUser: () => assert.fail('must never activate without confirmed assignment'),
  })
  harness.render()
  await settle()
  buttonNamed(harness.render(), 'Подтвердить доступ').props.onClick()
  await settle()
  assert.equal(account.status, 'Ожидает подтверждения')
  accountBranchPicker(harness.render()).props.onValueChange('missing-branch')
  assert.equal(buttonNamed(harness.render(), 'Подтвердить доступ').props.disabled, true)
  accountBranchPicker(harness.render()).props.onValueChange('branch-1')
  buttonNamed(harness.render(), 'Подтвердить доступ').props.onClick()
  await settle()
  await settle()
  assert.equal(account.branchId, null)
  assert(nodes(harness.render()).some((node) => node.props.role === 'alert'))
})

test('account list outage has explicit recovery and repeated refreshes coalesce', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', {
    fetchUsers: async () => {
      calls++
      if (calls === 1) throw new Error('unavailable')
      await gate
      return [pendingAccount()]
    },
  })
  harness.render()
  await settle()
  const failed = harness.render()
  assert(nodes(failed).some((node) => node.props.role === 'alert'))
  assert.doesNotMatch(textContent(failed), /Заявок и аккаунтов пока нет/)
  const refresh = buttonNamed(failed, 'Обновить список')
  refresh.props.onClick()
  refresh.props.onClick()
  await settle()
  assert.equal(calls, 2)
  release()
  await settle()
  assert.equal(accountBranchPicker(harness.render()).props.value, null)
})

test('malformed account rows show a recovery error instead of crashing account cards', async () => {
  for (const rows of [{}, [null], [{ ...pendingAccount(), username: undefined }]]) {
    const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', { fetchUsers: async () => rows })
    harness.render()
    await settle()
    assert(nodes(harness.render()).some((node) => node.props.role === 'alert'))
  }
})

test('sharing a coach registration link has manual fallback without clipboard permissions or extra API calls', async () => {
  let reads = 0
  const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', {
    fetchUsers: async () => {
      reads++
      return []
    },
  })
  harness.render()
  await settle()
  buttonNamed(harness.render(), 'Скопировать ссылку').props.onClick()
  await settle()
  const tree = harness.render()
  const link = nodes(tree).find((node) => node.props['aria-label'] === 'Ссылка для регистрации тренера')
  assert.equal(link.props.readOnly, true)
  assert.equal(link.props.value, 'http://localhost:3001/register')
  assert.match(textContent(tree), /Не удалось скопировать автоматически/)
  assert.match(textContent(tree), /на другом компьютере она не откроется/)
  assert.equal(reads, 1)
})

test('account data from a previous session is ignored after switching users', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', {
    fetchUsers: async () => {
      await gate
      return [pendingAccount()]
    },
  })
  harness.store.authStore.sessionVersion = 1
  harness.render()
  harness.store.authStore.sessionVersion = 2
  harness.store.authStore.isAdmin = false
  harness.render()
  release()
  await settle()
  assert.doesNotMatch(textContent(harness.render()), /anna/)
})

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

const registrationFields = (tree) => nodes(tree).filter((node) => node.type === 'Input')
const registrationForm = (tree) => nodes(tree).find((node) => node.type === 'form')
function fillRegistration(
  harness,
  { username = ' Coach.New ', password = 'strong-password', confirmation = password } = {},
) {
  const fields = registrationFields(harness.render())
  for (const [index, value] of [username, password, confirmation].entries())
    fields[index].props.onChange({ target: { value } })
  return registrationForm(harness.render())
}

test('registration guards double submissions, never logs in, and clears passwords after confirmation', async () => {
  const calls = []
  let release
  const harness = componentHarness('components/CoachRegistration.tsx', 'CoachRegistration', {
    register: (...args) => {
      calls.push(args)
      return new Promise((resolve) => {
        release = resolve
      })
    },
  })
  harness.store.authStore.login = () => assert.fail('registration must not create a login session')
  const form = fillRegistration(harness)
  const first = form.props.onSubmit({ preventDefault() {} })
  await form.props.onSubmit({ preventDefault() {} })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['coach.new', 'strong-password', 'registration-attempt'])
  assert(registrationFields(harness.render()).every((field) => field.props.disabled))
  release()
  await first
  const confirmed = harness.render()
  assert.equal(registrationFields(confirmed).length, 0)
  assert(nodes(confirmed).some((node) => node.props.role === 'status'))
  assert.doesNotMatch(JSON.stringify(confirmed), /strong-password/)
})

test('uncertain registration retries identical credentials without silent background requests', async () => {
  const calls = []
  const harness = componentHarness('components/CoachRegistration.tsx', 'CoachRegistration', {
    register: async (...args) => {
      calls.push(args)
      if (calls.length === 1) throw new Error('connection lost after commit')
    },
  })
  await fillRegistration(harness).props.onSubmit({ preventDefault() {} })
  await settle()
  const retry = harness.render()
  assert.equal(calls.length, 1)
  assert(registrationFields(retry).every((field) => field.props.disabled))
  assert(nodes(retry).some((node) => node.props.role === 'alert'))
  await registrationForm(retry).props.onSubmit({ preventDefault() {} })
  assert.deepEqual(calls[1], calls[0])
  assert(nodes(harness.render()).some((node) => node.props.role === 'status'))
})

test('registration rejects invalid usernames, short passwords and mismatched confirmation locally', async () => {
  for (const values of [{ username: 'admin<script>' }, { password: 'short' }, { confirmation: 'different-password' }]) {
    const harness = componentHarness('components/CoachRegistration.tsx', 'CoachRegistration', {
      register: () => assert.fail('invalid form must not reach the server'),
    })
    await fillRegistration(harness, values).props.onSubmit({ preventDefault() {} })
    assert(nodes(harness.render()).some((node) => node.props.role === 'alert'))
    assert(registrationFields(harness.render()).every((field) => !field.props.disabled))
  }
})

const dashboardSummary = (remainingLessons) => ({
  totalClients: 1,
  activeClients: 1,
  pausedClients: 0,
  archivedClients: 0,
  previewTotal: 1,
  previewLimit: 5,
  clientsPreview: [
    { id: 'a', childName: 'Child', parentName: 'Parent', phone: '', initials: '', status: 'Активен', remainingLessons },
  ],
})
const confirmedBalance = [
  { clientId: 'a', success: true, client: { remainingLessons: 1, totalLessons: 2, status: 'Активен' } },
]
const modalFor = (tree) => nodes(tree).find((node) => node.type === 'AttendanceModal')
const displayedBalance = (tree) => nodes(tree).find((node) => node.type === 'Badge').props.children[0]

test('dashboard uses confirmed balances without another server request', async () => {
  let calls = 0
  const harness = componentHarness('components/AdminWorkspace.tsx', 'Dashboard', {
    getDashboardSummary: async () => {
      calls++
      return dashboardSummary(2)
    },
  })
  harness.render()
  await settle()
  const loaded = harness.render()
  assert.equal(displayedBalance(loaded), 2)
  modalFor(loaded).props.onSaved(confirmedBalance)
  assert.equal(displayedBalance(harness.render()), 1)
  await settle()
  assert.equal(calls, 1)
})

test('a delayed dashboard read cannot overwrite balances confirmed while it was loading', async () => {
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const harness = componentHarness('components/AdminWorkspace.tsx', 'Dashboard', { getDashboardSummary: () => pending })
  modalFor(harness.render()).props.onSaved(confirmedBalance)
  release(dashboardSummary(2))
  await settle()
  assert.equal(displayedBalance(harness.render()), 1)
})

test('older GAS without balance snapshots refreshes the dashboard exactly once', async () => {
  let calls = 0
  const harness = componentHarness('components/AdminWorkspace.tsx', 'Dashboard', {
    getDashboardSummary: async () => dashboardSummary(++calls === 1 ? 2 : 1),
  })
  harness.render()
  await settle()
  modalFor(harness.render()).props.onSaved([{ clientId: 'a', success: true }])
  harness.render()
  await settle()
  assert.equal(displayedBalance(harness.render()), 1)
  assert.equal(calls, 2)
})

test('creating a lesson makes no option request until the optional pupil picker opens', async () => {
  let requests = 0
  const harness = componentHarness('components/CreateLessonModal.tsx', 'CreateLessonModal', {
    searchClientOptions: async () => {
      requests++
      return [{ id: 'child', childName: 'Child', category: 'плавание' }]
    },
  })
  const props = { isOpen: true, onClose() {} }
  const tree = harness.render(props)
  await settle()
  assert.equal(requests, 0)
  const picker = nodes(tree).find((node) => node.type === 'Select' && node.props.value === '__none__')
  picker.props.onOpenChange(true)
  harness.render(props)
  await settle()
  assert.equal(requests, 1)
  const loadedPicker = nodes(harness.render(props)).find(
    (node) => node.type === 'Select' && node.props.value === '__none__',
  )
  loadedPicker.props.onOpenChange(false)
  loadedPicker.props.onOpenChange(true)
  harness.render(props)
  await settle()
  assert.equal(requests, 1, 'same mounted form reuses its loaded options')
})

test('a failed optional pupil search exposes an error and retries only when reopened', async () => {
  let requests = 0
  const harness = componentHarness('components/CreateLessonModal.tsx', 'CreateLessonModal', {
    searchClientOptions: async () => {
      requests++
      if (requests === 1) throw new Error('offline')
      return [{ id: 'child', childName: 'Child', category: 'плавание' }]
    },
  })
  const props = { isOpen: true, onClose() {} }
  const pickerFor = (tree) => nodes(tree).find((node) => node.type === 'Select' && node.props.value === '__none__')
  pickerFor(harness.render(props)).props.onOpenChange(true)
  harness.render(props)
  await settle()
  const failed = harness.render(props)
  assert.ok(nodes(failed).some((node) => node.props?.role === 'alert'))
  assert.equal(requests, 1)
  pickerFor(failed).props.onOpenChange(true)
  harness.render(props)
  await settle()
  assert.equal(requests, 2)
  assert.ok(!nodes(harness.render(props)).some((node) => node.props?.role === 'alert'))
})

test('subscription pagination coalesces rapid clicks and ignores an old page after a new search', async () => {
  const calls = []
  let releaseOldPage
  const oldPage = new Promise((resolve) => {
    releaseOldPage = resolve
  })
  const page = (id) => ({
    items: [{ id, childName: id, paidAmount: 0 }],
    total: 2,
    page: 1,
    pageSize: 50,
    hasMore: true,
  })
  const harness = componentHarness('components/SubscriptionsView.tsx', 'SubscriptionsView', {
    getSubscriptionsPage: async (number, _size, _signal, _branch, query) => {
      calls.push([number, query])
      return number > 1 ? oldPage : page(query || 'initial')
    },
  })
  harness.render()
  harness.runTimers()
  await settle()
  const tree = harness.render()
  const more = nodes(tree).find((node) => node.type === 'Button')
  more.props.onClick()
  more.props.onClick()
  assert.equal(calls.length, 2, 'only one next-page request is sent')
  nodes(tree)
    .find((node) => node.type === 'Input')
    .props.onChange({ target: { value: 'new' } })
  harness.render()
  harness.runTimers()
  await settle()
  releaseOldPage(page('outdated'))
  await settle()
  const result = harness.render()
  const childNames = nodes(result)
    .filter((node) => node.type === 'TableCell')
    .map((node) => node.props.children)
  assert.ok(childNames.includes('new'))
  assert.ok(!childNames.includes('outdated'))
  const search = nodes(result).find((node) => node.type === 'Input')
  search.props.onChange({ target: { value: 'new  ' } })
  harness.render()
  harness.runTimers()
  await settle()
  assert.equal(calls.length, 3, 'trailing spaces do not repeat the same server search')
})

test('administrative imports are deferred and profile effects depend on pupil ID, not list object identity', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const page = read('app/page.tsx')
  assert.match(page, /dynamic\(\(\) => import\('@\/components\/AdminWorkspace'\)/)
  assert.doesNotMatch(page, /from '@\/components\/ui\/(select|sheet)'|getDashboardSummary/)
  assert.match(read('components/ClientsView.tsx'), /\[selectedAccountingClientId, store.authStore.isAdmin\]/)
  assert.doesNotMatch(read('components/ClientsView.tsx'), /\[selectedClient, store.authStore.isAdmin\]/)
})
