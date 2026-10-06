const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// Exercise component event/effect logic without a browser or DOM dependency.
// Effects are committed after render; cleanup and stable dependencies are retained.
function componentHarness(file, exportName, apiClient, now) {
  const hooks = []
  const effects = []
  const timers = new Map()
  const intervals = new Map()
  const listeners = new Map()
  let currentTime = now?.getTime()
  class ClockDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [currentTime ?? Date.now()]))
    }
    static now() {
      return currentTime ?? Date.now()
    }
  }
  const events = (target) => ({
    addEventListener: (event, callback) => listeners.set(`${target}:${event}`, callback),
    removeEventListener: (event) => listeners.delete(`${target}:${event}`),
  })
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
    useCallback(callback, deps) {
      const index = cursor++
      if (!sameDeps(hooks[index]?.deps, deps)) hooks[index] = { deps, callback }
      return hooks[index].callback
    },
    useMemo(factory, deps) {
      const index = cursor++
      if (!sameDeps(hooks[index]?.deps, deps)) hooks[index] = { deps, value: factory() }
      return hooks[index].value
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
    branchLessons: [],
    currentCoachAccounts: [],
    hasLoadedCoachAccounts: file === 'components/CreateLessonModal.tsx',
    rememberCoachAccounts(accounts) {
      this.currentCoachAccounts = accounts
      this.hasLoadedCoachAccounts = true
    },
    authStore: { isAdmin: true, isCoach: false, user: { id: 'admin-1' }, sessionVersion: 1 },
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
    Date: ClockDate,
    AbortController,
    setInterval: () => 1,
    clearInterval: () => {},
    window: {
      ...events('window'),
      setInterval: (callback, delay) => {
        intervals.set(++timerId, { callback, delay })
        return timerId
      },
      clearInterval: (id) => intervals.delete(id),
      confirm: () => true,
      location: { origin: 'http://localhost:3001' },
      setTimeout: (callback) => {
        timers.set(++timerId, callback)
        return timerId
      },
      clearTimeout: (id) => timers.delete(id),
    },
    document: events('document'),
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
      if (name === '@/lib/trainer-options') return require('../.test-dist/trainer-options.js')
      if (name === '@/lib/normalizers' || name === '@/lib/subscription-pricing' || name === '@/lib/creation-retry') {
        const moduleExports = {}
        const dependency = name.slice(2) + '.ts'
        const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', dependency), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText
        vm.runInNewContext(code, {
          exports: moduleExports,
          require: () => require('../.test-dist/utils/date-core.js'),
        })
        return moduleExports
      }
      if (['./ClientAttendanceHistory', './AttendanceModal', './RoleGuard'].includes(name)) return elements
      if (name === '@/lib/api-client')
        return { apiClient, createRequestId: () => 'registration-attempt', ApiError: Error }
      if (
        name === '@/lib/utils/date' &&
        ['components/CoachDashboard.tsx', 'components/AdminWorkspace.tsx', 'components/ScheduleView.tsx'].includes(file)
      )
        return require('../.test-dist/utils/date-core.js')
      if (name === '@/lib/utils/date')
        return { isValidDateOnly: () => true, parseTimeToHHMM: (value) => value, isLessonOnDay: () => true }
      if (name.startsWith('@/components/') || name === 'lucide-react') return elements
      throw new Error('Unexpected dependency: ' + name)
    },
  })
  return {
    store,
    intervals,
    listeners,
    setTime(date) {
      currentTime = date.getTime()
    },
    tickClock() {
      intervals.forEach(({ callback }) => callback())
    },
    dispatchEvent(target, event) {
      listeners.get(`${target}:${event}`)?.()
    },
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

test('coach creation skips the account read for profiles but refreshes a newly created login', async () => {
  for (const withLogin of [false, true]) {
    let reads = 0
    let creates = 0
    const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', {
      fetchUsers: async () => {
        reads++
        return []
      },
    })
    harness.store.selectedBranchId = ''
    harness.store.createCoach = async (data) => {
      creates++
      assert.equal(data.name, 'Катя Самот')
      assert.equal(data.branchId, 'branch-1')
      assert.equal(Boolean(data.username), withLogin)
    }
    harness.render()
    await settle()
    let tree = harness.render()
    nodes(tree)
      .find((node) => node.type === 'Dialog')
      .props.onOpenChange(true)
    for (const [placeholder, value] of [
      ['Имя', 'Катя'],
      ['Фамилия', 'Самот'],
      ...(withLogin
        ? [
            ['Логин тренера', 'katya'],
            ['Временный пароль (минимум 8 символов)', 'test-password'],
          ]
        : []),
    ]) {
      tree = harness.render()
      nodes(tree)
        .find((node) => node.type === 'Input' && node.props.placeholder === placeholder)
        .props.onChange({ target: { value } })
    }
    tree = harness.render()
    assert(!textContent(tree).includes('филиал тренера нужно выбрать явно'), 'selected single branch needs no warning')
    buttonNamed(tree, 'Сохранить').props.onClick()
    buttonNamed(tree, 'Сохранить').props.onClick()
    await settle()
    assert.equal(creates, 1)
    assert.equal(reads, withLogin ? 2 : 1)
    assert.equal(nodes(harness.render()).find((node) => node.type === 'Dialog').props.open, false)
  }
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

const dashboardHarness = (lessons, now = new Date(2026, 9, 5, 12)) => {
  const opened = []
  let navigations = 0
  const harness = componentHarness('components/CoachDashboard.tsx', 'CoachDashboard', {})
  const props = {
    lessons,
    now,
    branchName: 'Бассейн',
    onSchedule: () => navigations++,
    onOpenLesson: (lesson, date) =>
      opened.push([lesson.id, require('../.test-dist/utils/date-core.js').toLocalDateOnly(date)]),
  }
  return { render: () => harness.render(props), opened, navigations: () => navigations }
}
const lessonButtons = (tree) =>
  nodes(tree).filter((node) => String(node.props['aria-label'] || '').startsWith('Отметить посещаемость:'))

test('coach dashboard empty day provides useful navigation without fake saved marks or network calls', () => {
  const dashboard = dashboardHarness([])
  const tree = dashboard.render()
  assert.match(textContent(tree), /На сегодня занятий нет/)
  assert.match(textContent(tree), /Нет в ближайшие 14 дней/)
  assert.doesNotMatch(textContent(tree), /учеников пришло|100%|успешно сохранено/i)
  const calendar = nodes(tree).filter((node) => typeof node.props['aria-pressed'] === 'boolean')
  assert.equal(calendar.length, 7)
  assert.equal(calendar.filter((node) => node.props['aria-pressed']).length, 1)
  nodes(tree)
    .find((node) => node.type === 'button' && textContent(node) === 'Открыть расписание')
    .props.onClick()
  assert.equal(dashboard.navigations(), 1)
})

test('coach calendar opens the selected dated occurrence, sorts lessons and returns to today', () => {
  const dashboard = dashboardHarness([
    { id: 'late', title: 'Вечер', date: '2026-10-06', time: '18:00', dayOfWeek: 'Вт' },
    { id: 'early', title: 'Утро', date: '2026-10-06', time: '09:00', dayOfWeek: 'Вт' },
  ])
  nodes(dashboard.render())
    .find((node) => node.props['aria-label'] === 'вторник, 6 октября')
    .props.onClick()
  const buttons = lessonButtons(dashboard.render())
  assert.equal(buttons.length, 2)
  assert.match(buttons[0].props['aria-label'], /Утро/)
  buttons[0].props.onClick()
  assert.deepEqual(dashboard.opened, [['early', '2026-10-06']])
  nodes(dashboard.render())
    .find((node) => node.type === 'button' && textContent(node) === 'Сегодня')
    .props.onClick()
  assert.match(textContent(dashboard.render()), /На сегодня занятий нет/)
})

test('coach calendar crosses year boundaries without losing the actual lesson date', () => {
  const dashboard = dashboardHarness(
    [{ id: 'new-year', title: 'Первое занятие', date: '2027-01-04', time: '17:00', dayOfWeek: 'Пн' }],
    new Date(2026, 11, 31, 12),
  )
  nodes(dashboard.render())
    .find((node) => node.props['aria-label'] === 'Следующая неделя')
    .props.onClick()
  lessonButtons(dashboard.render())[0].props.onClick()
  assert.deepEqual(dashboard.opened, [['new-year', '2027-01-04']])
  nodes(dashboard.render())
    .find((node) => node.props['aria-label'] === 'Предыдущая неделя')
    .props.onClick()
  assert.equal(lessonButtons(dashboard.render()).length, 0)
})

test('nearest lesson skips past or malformed times and recurring lessons respect their start date', () => {
  const dashboard = dashboardHarness([
    { id: 'past', title: 'Прошло', date: '2026-10-05', time: '09:00', dayOfWeek: 'Пн' },
    { id: 'bad-time', title: 'Без времени', date: '2026-10-06', time: 'invalid', dayOfWeek: 'Вт' },
    { id: 'recurring', title: 'Повторяется', date: '2026-10-13', time: '18:00', dayOfWeek: 'Вт', isRecurring: true },
  ])
  nodes(dashboard.render())
    .find((node) => node.props['aria-label'] === 'среда, 7 октября')
    .props.onClick()
  const nearest = nodes(dashboard.render()).find(
    (node) => node.type === 'button' && textContent(node).startsWith('Ближайшее:'),
  )
  assert.match(textContent(nearest), /Повторяется/)
  nearest.props.onClick()
  assert.deepEqual(dashboard.opened, [['recurring', '2026-10-13']])
})

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

const lessonGroups = (tree) => nodes(tree).filter((node) => node.props['data-lesson-status'])
const todayLesson = (id, time, overrides = {}) => ({
  id,
  title: id,
  date: '2026-10-05',
  dayOfWeek: 'Пн',
  time,
  duration: '1 час',
  ...overrides,
})

test('admin dashboard at 21:24 groups completed lessons last and preserves attendance access and daily totals', async () => {
  let calls = 0
  const harness = componentHarness(
    'components/AdminWorkspace.tsx',
    'Dashboard',
    {
      getDashboardSummary: async () => {
        calls++
        return dashboardSummary(2)
      },
    },
    new Date(2026, 9, 5, 21, 24),
  )
  harness.store.sortedBranchLessons = [
    todayLesson('finished-17', '17:00'),
    todayLesson('future-23', '23:00'),
    todayLesson('ongoing-21', '21:00'),
    todayLesson('missing-duration', '18:00', { duration: '' }),
    todayLesson('bad-time', 'invalid'),
    todayLesson('finished-19', '19:00'),
    todayLesson('old-date', '20:00', { date: '2026-10-04' }),
    todayLesson('recurring', '22:30', { date: '2026-09-28', isRecurring: true }),
  ]
  harness.render()
  await settle()
  let tree = harness.render()
  const groups = lessonGroups(tree)
  assert.deepEqual(
    groups.map((group) => group.props['data-lesson-status']),
    ['ongoing', 'upcoming', 'unknown', 'completed'],
  )
  assert.match(textContent(groups[0]), /Идёт сейчас.*ongoing-21/)
  assert.match(textContent(groups[1]), /Предстоящие.*recurring.*future-23/)
  assert.match(textContent(groups[2]), /Время требует проверки.*bad-time.*missing-duration/)
  assert.match(textContent(groups[3]), /Завершённые.*finished-17.*finished-19/)
  assert.doesNotMatch(textContent(tree), /old-date/)
  assert.match(textContent(tree), /Занятий сегодня7/)
  nodes(groups[3])
    .find((node) => node.type === 'button')
    .props.onClick()
  tree = harness.render()
  assert.equal(modalFor(tree).props.lesson.id, 'finished-17')
  assert.equal(modalFor(tree).props.occurrenceDate, '2026-10-05')
  nodes(groups[1])
    .find((node) => node.type === 'button')
    .props.onClick()
  assert.equal(
    modalFor(harness.render()).props.occurrenceDate,
    '2026-10-05',
    'recurring attendance uses today, not its start date',
  )
  assert.equal(calls, 1)
  harness.unmount()
})

test('admin dashboard clock crosses start, end and midnight without extra GAS reads and cleans up on unmount', async () => {
  let calls = 0
  const harness = componentHarness(
    'components/AdminWorkspace.tsx',
    'Dashboard',
    {
      getDashboardSummary: async () => {
        calls++
        return dashboardSummary(2)
      },
    },
    new Date(2026, 9, 5, 20, 59),
  )
  harness.store.sortedBranchLessons = [todayLesson('evening', '21:00')]
  harness.render()
  await settle()
  assert.equal(lessonGroups(harness.render())[0].props['data-lesson-status'], 'upcoming')
  assert.equal(harness.intervals.size, 1)
  assert.equal([...harness.intervals.values()][0].delay, 30_000)
  harness.setTime(new Date(2026, 9, 5, 21))
  harness.tickClock()
  assert.equal(lessonGroups(harness.render())[0].props['data-lesson-status'], 'ongoing')
  harness.setTime(new Date(2026, 9, 5, 22))
  harness.dispatchEvent('window', 'focus')
  assert.equal(lessonGroups(harness.render())[0].props['data-lesson-status'], 'completed')
  harness.setTime(new Date(2026, 9, 6))
  harness.dispatchEvent('document', 'visibilitychange')
  const tomorrow = harness.render()
  assert.equal(lessonGroups(tomorrow).length, 0)
  assert.match(textContent(tomorrow), /На сегодня занятий нет/)
  assert.match(textContent(tomorrow), /Занятий сегодня0/)
  await settle()
  assert.equal(calls, 1)
  harness.unmount()
  assert.equal(harness.intervals.size, 0)
  assert.equal(harness.listeners.size, 0)
  harness.tickClock()
  harness.dispatchEvent('window', 'focus')
  assert.equal(calls, 1)
})

test('admin summary presents real totals and business actions without additional reads', async () => {
  let calls = 0
  const screens = []
  const harness = componentHarness('components/AdminWorkspace.tsx', 'Dashboard', {
    getDashboardSummary: async () => {
      calls++
      return { ...dashboardSummary(2), totalClients: 38, activeClients: 29, pausedClients: 7 }
    },
  })
  const props = { setScreen: (screen) => screens.push(screen) }
  const loading = harness.render(props)
  assert(textContent(loading).includes('—'))
  await settle()
  const tree = harness.render(props)
  const text = textContent(tree)
  assert(text.includes('Всего клиентов38'))
  assert(text.includes('Активных клиентов29'))
  assert(text.includes('На паузе7'))
  assert(!text.includes('Ваш день'))
  for (const label of ['Открыть расписание', 'Все клиенты', 'Выбрать другой день']) {
    nodes(tree)
      .find((node) => node.type === 'button' && textContent(node) === label)
      .props.onClick()
  }
  assert.deepEqual(screens, ['Расписание', 'Клиенты и дети', 'Расписание'])
  harness.render(props)
  await settle()
  assert.equal(calls, 1)
})

test('admin summary failure keeps unknown totals and offers an explicit retry', async () => {
  let calls = 0
  const harness = componentHarness('components/AdminWorkspace.tsx', 'Dashboard', {
    getDashboardSummary: async () => {
      if (++calls === 1) throw new Error('private diagnostic')
      return dashboardSummary(2)
    },
  })
  harness.render()
  await settle()
  const failed = harness.render()
  assert(textContent(failed).includes('Всего клиентов—'))
  assert(!textContent(failed).includes('private diagnostic'))
  assert(nodes(failed).some((node) => node.props.role === 'alert'))
  assert.equal(calls, 1)
  nodes(failed)
    .find((node) => node.type === 'button' && textContent(node) === 'Повторить загрузку')
    .props.onClick()
  harness.render()
  await settle()
  assert(textContent(harness.render()).includes('Всего клиентов1'))
  assert.equal(calls, 2)
})

test('admin branch selector has readable options and finance has no unfinished-section notice', () => {
  const harness = componentHarness('components/AdminWorkspace.tsx', 'AdminWorkspace', {})
  harness.store.currentScreen = 'Финансы'
  const tree = harness.render()
  const picker = nodes(tree).find((node) => node.type === 'Select')
  assert.deepEqual(JSON.parse(JSON.stringify(picker.props.items)), [
    { value: 'all', label: 'Все филиалы' },
    { value: 'branch-1', label: 'Pool' },
  ])
  assert(!textContent(tree).includes('в разработке'))
  assert.equal(nodes(tree).find((node) => node.type === 'SelectContent').props.alignItemWithTrigger, false)
})

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

test('lesson picker includes an approved login without a profile and uses an independent popup', async () => {
  let calls = 0
  const harness = componentHarness('components/CreateLessonModal.tsx', 'CreateLessonModal', {
    fetchUsers: async () => {
      calls++
      return [{ ...pendingAccount(), branchId: 'branch-1', status: 'Активен' }]
    },
  })
  harness.store.coaches = [{ id: 'katya', name: 'Катя Самот', branchId: 'branch-1', userId: 'katya-login' }]
  harness.store.hasLoadedCoachAccounts = false
  const props = { isOpen: true, onClose() {} }
  harness.render(props)
  await settle()
  let tree = harness.render(props)
  const picker = nodes(tree).find(
    (node) => node.type === 'Select' && nodes(node).some((child) => child.props['aria-label'] === 'Тренер занятия'),
  )
  assert.equal(picker.props.items.length, 2)
  assert(picker.props.items.some((item) => item.name === 'anna'))
  assert(picker.props.items.some((item) => item.name === 'Катя Самот'))
  assert.equal(picker.props.value, null)
  assert(
    nodes(tree)
      .filter((node) => node.type === 'SelectContent')
      .every((node) => node.props.alignItemWithTrigger === false),
  )
  picker.props.onValueChange('account:anna-id')
  tree = harness.render(props)
  assert.equal(
    nodes(tree).find((node) => node.type === 'Select' && node.props.items?.some((item) => item.name === 'anna')).props
      .value,
    'account:anna-id',
  )
  assert.equal(calls, 1)
  const branch = nodes(tree).find((node) => node.type === 'select')
  branch.props.onChange({ target: { value: 'other-pool' } })
  tree = harness.render(props)
  assert.equal(
    nodes(tree).find((node) => node.type === 'Select' && Array.isArray(node.props.items)).props.items.length,
    0,
  )
})

test('trainer reads expire only the current session on 401, not on outages or stale responses', async () => {
  for (const component of ['CoachesView', 'CreateLessonModal']) {
    for (const status of [401, 403, 503]) {
      let expired = 0
      const error = new Error('read failed')
      error.status = status
      const harness = componentHarness(`components/${component}.tsx`, component, {
        fetchUsers: async () => {
          throw error
        },
      })
      harness.store.hasLoadedCoachAccounts = false
      harness.store.authStore.sessionVersion = 1
      harness.store.authStore.expireSession = () => {
        expired++
        harness.store.authStore.sessionVersion++
      }
      harness.render({ isOpen: true, onClose() {} })
      await settle()
      assert.equal(expired, status === 401 ? 1 : 0)
    }
    let reject
    let expired = 0
    const pending = new Promise((_resolve, fail) => {
      reject = fail
    })
    const harness = componentHarness(`components/${component}.tsx`, component, { fetchUsers: () => pending })
    harness.store.hasLoadedCoachAccounts = false
    harness.store.authStore.sessionVersion = 1
    harness.store.authStore.expireSession = () => {
      expired++
    }
    harness.render({ isOpen: true, onClose() {} })
    harness.store.authStore.sessionVersion = 2
    const error = new Error('old session')
    error.status = 401
    reject(error)
    await settle()
    assert.equal(expired, 0)
  }
})

test('cached trainer cards remain visible while a fresh account read is in flight', () => {
  const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', {
    fetchUsers: () => new Promise(() => {}),
  })
  harness.store.currentCoachAccounts = [{ ...pendingAccount(), branchId: 'branch-1', status: 'Активен' }]
  const tree = harness.render()
  assert(textContent(tree).includes('anna'))
  assert(textContent(tree).includes('Логин: anna'))
  assert(textContent(tree).includes('Телефон не указан'))
  assert(textContent(tree).includes('Записей в расписании: 0'))
})

test('bootstrap account snapshot displays login-only trainers without a second getUsers request', async () => {
  let reads = 0
  const harness = componentHarness('components/CoachesView.tsx', 'CoachesView', {
    fetchUsers: async () => {
      reads++
      return []
    },
  })
  harness.store.hasLoadedCoachAccounts = true
  harness.store.currentCoachAccounts = [{ ...pendingAccount(), branchId: 'branch-1', status: 'Активен' }]
  const tree = harness.render()
  assert(textContent(tree).includes('anna'))
  await settle()
  assert.equal(reads, 0)
  assert.equal(buttonNamed(harness.render(), 'Обновить список').props.disabled, false)
  buttonNamed(harness.render(), 'Обновить список').props.onClick()
  await settle()
  assert.equal(reads, 1, 'manual refresh must still read authoritative account data')
})

test('trainer choices merge by explicit identity, never by name, and exclude foreign or pending logins', () => {
  const { trainerOptions } = require('../.test-dist/trainer-options.js')
  const profiles = [
    { id: 'a', name: 'Same Name', branchId: 1, userId: 'linked' },
    { id: 'b', name: 'Same Name', branchId: '1' },
  ]
  const accounts = [
    { id: 'linked', username: 'login1', branchId: '1', status: 'Активен' },
    { id: 'unlinked', username: 'login2', branchId: '1', status: 'Активен' },
    { id: 'foreign', username: 'foreign', branchId: '2', status: 'Активен' },
    { id: 'pending', username: 'pending', branchId: '1', status: 'Ожидает подтверждения' },
    { id: 'disabled', username: 'disabled', branchId: '1', status: 'Отключен' },
  ]
  const options = trainerOptions(profiles, accounts, '1')
  assert.equal(options.length, 3)
  assert.equal(new Set(options.map((item) => item.value)).size, 3)
  assert(options.some((item) => item.value === 'account:unlinked'))
  assert(!options.some((item) => item.value === 'account:linked'))
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
  buttonNamed(tree, 'Выбрать клиентов').props.onClick()
  harness.render(props)
  await settle()
  assert.equal(requests, 1)
  const loaded = harness.render(props)
  nodes(loaded)
    .find((node) => node.props['aria-label'] === 'Поиск клиентов занятия')
    .props.onChange({ target: { value: 'Child' } })
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
  buttonNamed(harness.render(props), 'Выбрать клиентов').props.onClick()
  harness.render(props)
  await settle()
  const failed = harness.render(props)
  assert.ok(nodes(failed).some((node) => node.props?.role === 'alert'))
  assert.equal(requests, 1)
  nodes(failed)
    .find((node) => node.type === 'button' && textContent(node) === 'Повторить загрузку клиентов')
    .props.onClick()
  harness.render(props)
  await settle()
  assert.equal(requests, 2)
  assert.ok(!nodes(harness.render(props)).some((node) => node.props?.role === 'alert'))
})

test('lesson time picker excludes elapsed slots and offers all slots on a future date', () => {
  const harness = componentHarness('components/CreateLessonModal.tsx', 'CreateLessonModal', {})
  const props = { isOpen: true, onClose() {} }
  let tree = harness.render(props)
  tree = harness.render(props)
  const dateInput = nodes(tree).find((node) => node.type === 'Input' && node.props.type === 'date')
  const today = dateInput.props.value
  const now = Date.now()
  for (const item of nodes(tree).filter((node) => node.type === 'SelectItem' && /^\d\d:\d\d$/.test(node.props.value)))
    assert(new Date(`${today}T${item.props.value}:00`).getTime() > now)
  const tomorrow = new Date(`${today}T12:00:00`)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
  dateInput.props.onChange({ target: { value: date } })
  tree = harness.render(props)
  assert.equal(
    nodes(tree).filter((node) => node.type === 'SelectItem' && /^\d\d:\d\d$/.test(node.props.value)).length,
    36,
  )
})

test('schedule opens on today for admin and coach, with past dates only in an explicitly selected view', () => {
  for (const isCoach of [false, true]) {
    const h = componentHarness('components/ScheduleView.tsx', 'ScheduleView', {}, new Date('2026-10-06T16:44:00'))
    h.store.authStore.isCoach = isCoach
    h.store.authStore.isAdmin = !isCoach
    h.store.sortedBranchLessons = [
      {
        id: 'yesterday',
        title: 'Yesterday lesson',
        date: '2026-10-05',
        dayOfWeek: 'Пн',
        time: '17:00',
        duration: '1 час',
      },
      { id: 'today', title: 'Today lesson', date: '2026-10-06', dayOfWeek: 'Вт', time: '17:00', duration: '1 час' },
    ]
    let tree = h.render()
    assert(textContent(tree).includes('Today lesson'))
    assert(!textContent(tree).includes('Yesterday lesson'))
    buttonNamed(tree, 'Неделя').props.onClick()
    tree = h.render()
    assert(textContent(tree).includes('Yesterday lesson'))
    nodes(tree).find((node) => node.type === 'button' && textContent(node) === 'Пн 5').props.onClick()
    tree = h.render()
    assert(textContent(tree).includes('Yesterday lesson'))
    assert(!textContent(tree).includes('Today lesson'))
    nodes(tree).find((node) => node.type === 'button' && textContent(node) === 'Вт 6').props.onClick()
    tree = h.render()
    assert(!textContent(tree).includes('Yesterday lesson'))
    assert(textContent(tree).includes('Today lesson'))
  }
})

test('checkbox selection sends all 20 pupils in one create and guards double clicks', async () => {
  const pupils = Array.from({ length: 20 }, (_, index) => ({
    id: 'child-' + index,
    childName: 'Child ' + index,
    parentName: 'Parent',
    remainingLessons: 4,
  }))
  const harness = componentHarness('components/CreateLessonModal.tsx', 'CreateLessonModal', {
    searchClientOptions: async () => pupils,
  })
  harness.store.coaches = [{ id: 'coach', name: 'Trainer', branchId: 'branch-1' }]
  const calls = []
  harness.store.createLesson = async (payload) => {
    calls.push(payload)
  }
  const props = { isOpen: true, onClose() {} }
  buttonNamed(harness.render(props), 'Выбрать клиентов').props.onClick()
  harness.render(props)
  await settle()
  let tree = harness.render(props)
  const trainer = nodes(tree).find(
    (node) => node.type === 'Select' && node.props.items?.some((item) => item.name === 'Trainer'),
  )
  trainer.props.onValueChange('profile:coach')
  tree = harness.render(props)
  for (const checkbox of nodes(tree).filter((node) => node.type === 'input' && node.props.type === 'checkbox'))
    checkbox.props.onChange({ target: { checked: true } })
  tree = harness.render(props)
  assert(textContent(tree).includes('Выбрано: 20'))
  const create = buttonNamed(tree, 'Создать и записать (20)')
  create.props.onClick()
  create.props.onClick()
  await settle()
  assert.equal(calls.length, 1)
  assert.deepEqual(
    Array.from(calls[0].clientIds),
    pupils.map((pupil) => pupil.id),
  )
  assert.equal(calls[0].maxCapacity, 20)
})

test('lesson form retries the frozen attempt after lost reply, including after its start time', async () => {
  const h = componentHarness(
    'components/CreateLessonModal.tsx',
    'CreateLessonModal',
    {},
    new Date('2026-10-06T10:00:00'),
  )
  h.store.coaches = [{ id: 'coach', name: 'Trainer', branchId: 'branch-1' }]
  const calls = []
  let closed = 0
  h.store.createLesson = async (payload) => {
    calls.push(payload)
    if (calls.length === 1) throw new Error('lost reply')
    return { id: 'confirmed' }
  }
  const props = { isOpen: true, onClose: () => closed++ }
  let tree = h.render(props)
  nodes(tree)
    .find((node) => node.type === 'Select' && node.props.items?.some((item) => item.name === 'Trainer'))
    .props.onValueChange('profile:coach')
  await buttonNamed(h.render(props), 'Создать занятие').props.onClick()
  tree = h.render(props)
  assert.equal(nodes(tree).find((node) => node.type === 'fieldset').props.disabled, true)
  nodes(tree)
    .find((node) => node.type === 'Dialog')
    .props.onOpenChange(false)
  assert.equal(closed, 0)
  h.setTime(new Date('2026-10-07T10:00:00'))
  h.render(props)
  await buttonNamed(h.render(props), 'Повторить тот же запрос').props.onClick()
  assert.deepEqual(calls[1], calls[0])
  assert.equal(closed, 1)
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
  assert.match(
    read('components/ClientsView.tsx'),
    /\[selectedAccountingClientId, store.authStore.isAdmin, accountingScope/,
  )
  assert.doesNotMatch(read('components/ClientsView.tsx'), /\[selectedClient, store.authStore.isAdmin\]/)
})

const accountingClient = (id = 'client-1', name = 'Анна') => ({
  id,
  childName: name,
  parentName: 'Родитель',
  phone: '',
  email: '',
  branchId: 'branch-1',
  status: 'Пауза',
  category: 'плавание',
  lessonsPerWeek: 1,
  paidAmount: 0,
  paymentBalance: 0,
  assignedLessonIds: [],
  attendanceHistory: [],
  subscription: { remainingLessons: 0, totalLessons: 0, paid: false },
})
const accountingSnapshot = (lessons = 4) => ({
  remainingLessons: lessons,
  totalLessons: lessons,
  paidAmount: lessons * 1375,
  paymentBalance: 0,
  category: 'плавание',
  lessonsPerWeek: 1,
  status: 'Активен',
})
const confirmedPayment = () => ({
  success: true,
  payment: { id: 'payment-1', clientId: 'client-1', requestId: 'registration-attempt', amount: 5500, lessonsAdded: 4 },
  ledgerEntry: { id: 'ledger-1', paymentId: 'payment-1' },
  client: accountingSnapshot(),
  audit: { success: true, checked: 1, discrepancies: [] },
})
const emptyAccounting = () => ({
  success: true,
  payments: [],
  ledger: [],
  audit: { success: true, checked: 1, discrepancies: [] },
})
const profileDialog = (tree) =>
  nodes(tree).find((node) => node.type === 'Dialog' && textContent(node).includes('Оплаты и продление'))
const paymentDialog = (tree) =>
  nodes(tree).find((node) => node.type === 'Dialog' && textContent(node).includes('Продление абонемента'))
async function startAccountingView(api, items = [accountingClient()]) {
  let listReads = 0
  const harness = componentHarness('components/ClientsView.tsx', 'ClientsView', {
    fetchClientsPage: async () => {
      listReads++
      return { items, page: 1, total: items.length, hasMore: false }
    },
    ...api,
  })
  harness.render()
  harness.runTimers()
  await settle()
  harness.render()
  return { harness, listReads: () => listReads }
}
const selectAccountingClient = (harness, name = 'Анна') => {
  nodes(harness.render())
    .find((node) => node.type === 'TableRow' && node.props.onClick && textContent(node).includes(name))
    .props.onClick()
  harness.render()
}
const openAndSubmitPayment = (harness) => {
  buttonNamed(harness.render(), 'Продлить абонемент').props.onClick()
  const save = buttonNamed(harness.render(), 'Сохранить платёж')
  save.props.onClick()
  return save
}

test('client creation UI prevents double submission and retains its first payment payload after lost reply', async () => {
  const attempts = []
  let fail
  const { harness: h } = await startAccountingView(
    {
      createClient: async (...args) => {
        attempts.push(args)
        if (attempts.length === 1)
          return new Promise((_, reject) => {
            fail = reject
          })
        return { id: 'confirmed-client' }
      },
    },
    [],
  )
  buttonNamed(h.render(), 'Добавить клиента').props.onClick()
  const addDialog = () =>
    nodes(h.render()).find((node) => node.type === 'Dialog' && textContent(node).includes('Новый клиент'))
  for (const [placeholder, value] of [
    ['Например, Екатерина', 'Anna'],
    ['Имя и фамилия', 'Parent'],
    ['+7 (___) ___-__-__', '79991234567'],
  ])
    nodes(addDialog())
      .find((node) => node.type === 'Input' && node.props.placeholder === placeholder)
      .props.onChange({ target: { value } })
  const selects = nodes(addDialog()).filter((node) => node.type === 'select')
  selects[0].props.onChange({ target: { value: 'плавание' } })
  selects[1].props.onChange({ target: { value: '1' } })
  const save = buttonNamed(h.render(), 'Создать профиль клиента')
  const first = save.props.onClick()
  await save.props.onClick()
  assert.equal(attempts.length, 1)
  fail(new Error('lost reply'))
  await first
  assert.equal(nodes(addDialog()).find((node) => node.type === 'fieldset').props.disabled, true)
  addDialog().props.onOpenChange(false)
  assert.equal(addDialog().props.open, true)
  await buttonNamed(h.render(), 'Повторить тот же запрос').props.onClick()
  assert.deepEqual(attempts[1], attempts[0])
  assert.equal(attempts[1][0].paidAmount, 5500)
  assert.equal(attempts[1][1], 'registration-attempt')
  assert.equal(addDialog().props.open, false)
})

test('empty-card deletion permits only valid zero-credit creation markers, not accounting movements', async () => {
  for (const [entry, permitted] of [
    [{ type: 'client_creation', lessonsDelta: 0, totalLessonsDelta: 0 }, true],
    [{ type: 'client_creation', lessonsDelta: 1, totalLessonsDelta: 1 }, false],
    [{ type: 'attendance_confirmation', lessonsDelta: 0, totalLessonsDelta: 0 }, false],
    [{ type: 'client_creation' }, false],
  ]) {
    const { harness } = await startAccountingView({
      getClientAccounting: async () => ({ ...emptyAccounting(), ledger: [entry] }),
    })
    selectAccountingClient(harness)
    await settle()
    assert.equal(buttonNamed(harness.render(), 'Удалить пустую карточку').props.disabled, !permitted)
  }
})

test('client accounting opens with one call and confirmed payment updates totals/history without a reload', async () => {
  let accountingReads = 0
  let writes = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { harness, listReads } = await startAccountingView({
    getClientAccounting: async () => {
      accountingReads++
      return emptyAccounting()
    },
    recordPayment: async () => {
      writes++
      await gate
      return confirmedPayment()
    },
  })
  selectAccountingClient(harness)
  await settle()
  assert.equal(accountingReads, 1)
  const save = openAndSubmitPayment(harness)
  save.props.onClick() // Same render: React has not yet committed loading=true.
  assert.equal(writes, 1)
  release()
  await settle()
  const tree = harness.render()
  assert.equal(paymentDialog(tree).props.open, false)
  assert.match(textContent(profileDialog(tree)), /Осталось занятий4/)
  assert.match(textContent(profileDialog(tree)), /В журнале движений: 1 операций/)
  assert.match(textContent(profileDialog(tree)), /совпадают с журналом/)
  assert.equal(accountingReads, 1, 'no follow-up history or audit read')
  harness.runTimers()
  await settle()
  assert.equal(listReads(), 1, 'no follow-up list read')
})

test('audit failure remains visible without hiding confirmed payment history', async () => {
  const { harness } = await startAccountingView({
    getClientAccounting: async () => ({
      ...emptyAccounting(),
      payments: [confirmedPayment().payment],
      audit: null,
      auditError: { message: 'Сверка недоступна' },
    }),
  })
  selectAccountingClient(harness)
  await settle()
  const tree = harness.render()
  const profile = textContent(profileDialog(tree))
  assert.match(profile, /\+4 занятий/)
  assert.match(profile, /Сверка: Сверка недоступна/)
  assert.doesNotMatch(profile, /Платежей пока нет|совпадают с журналом/)
  assert(buttonNamed(tree, 'Повторить загрузку истории'))
})

test('post-payment refresh failure is a warning, not a failed write, and retains the confirmed operation', async () => {
  let reads = 0
  let writes = 0
  const { harness } = await startAccountingView({
    getClientAccounting: async () => {
      if (++reads > 1) throw new Error('refresh failed')
      return emptyAccounting()
    },
    recordPayment: async () => {
      writes++
      const { ledgerEntry, audit, ...oldGas } = confirmedPayment()
      return oldGas
    },
  })
  selectAccountingClient(harness)
  await settle()
  openAndSubmitPayment(harness)
  await settle()
  const tree = harness.render()
  assert.equal(writes, 1)
  assert.equal(paymentDialog(tree).props.open, false)
  assert.match(textContent(profileDialog(tree)), /Осталось занятий4/)
  assert.match(textContent(profileDialog(tree)), /\+4 занятий/)
  assert.match(textContent(profileDialog(tree)), /Подтверждённые операции сохранены/)
  assert.doesNotMatch(textContent(paymentDialog(tree)), /refresh failed|Не удалось сохранить платёж/)
})

test('lost payment acknowledgement is recovered by one combined read, with no second write', async () => {
  let reads = 0
  let writes = 0
  const saved = confirmedPayment()
  const { harness, listReads } = await startAccountingView({
    getClientAccounting: async () =>
      ++reads === 1
        ? emptyAccounting()
        : {
            success: true,
            payments: [saved.payment],
            ledger: [saved.ledgerEntry],
            client: saved.client,
            audit: saved.audit,
          },
    recordPayment: async () => {
      writes++
      throw new Error('response lost')
    },
  })
  selectAccountingClient(harness)
  await settle()
  openAndSubmitPayment(harness)
  await settle()
  const tree = harness.render()
  assert.equal(writes, 1)
  assert.equal(reads, 2)
  assert.equal(paymentDialog(tree).props.open, false)
  assert.match(textContent(profileDialog(tree)), /Осталось занятий4/)
  harness.runTimers()
  await settle()
  assert.equal(listReads(), 1)
})

test('unconfirmed payment retry keeps the same requestId and duplicate result never adds history twice', async () => {
  const attempts = []
  let reads = 0
  const saved = confirmedPayment()
  const { harness } = await startAccountingView({
    getClientAccounting: async () => {
      if (++reads > 1) throw new Error('recovery offline')
      return { ...emptyAccounting(), payments: [saved.payment], ledger: [saved.ledgerEntry] }
    },
    recordPayment: async (...args) => {
      attempts.push(args)
      if (attempts.length === 1) throw new Error('unknown result')
      return { ...saved, duplicate: true, client: accountingSnapshot(8) }
    },
  })
  selectAccountingClient(harness)
  await settle()
  openAndSubmitPayment(harness)
  await settle()
  let tree = harness.render()
  assert.equal(paymentDialog(tree).props.open, true)
  const amountInput = nodes(paymentDialog(tree)).find((node) => node.type === 'Input' && node.props.type === 'number')
  assert.equal(amountInput.props.disabled, true)
  buttonNamed(tree, 'Сохранить платёж').props.onClick()
  await settle()
  tree = harness.render()
  assert.deepEqual(attempts[1], attempts[0])
  assert.equal(paymentDialog(tree).props.open, false)
  assert.match(textContent(profileDialog(tree)), /Осталось занятий8/)
  assert.match(textContent(profileDialog(tree)), /В журнале движений: 1 операций/)
})

test('an old history response cannot overwrite the confirmed new payment', async () => {
  let release
  const oldRead = new Promise((resolve) => {
    release = resolve
  })
  let reads = 0
  const saved = confirmedPayment()
  const { harness } = await startAccountingView({
    getClientAccounting: async () =>
      ++reads === 1
        ? oldRead
        : {
            success: true,
            payments: [saved.payment],
            ledger: [saved.ledgerEntry],
            client: saved.client,
            audit: saved.audit,
          },
    recordPayment: async () => saved,
  })
  selectAccountingClient(harness)
  openAndSubmitPayment(harness)
  await settle()
  release({ ...emptyAccounting(), client: accountingSnapshot(0) })
  await settle()
  const tree = harness.render()
  assert.equal(reads, 2, 'one recovery refresh when initial history has not yet loaded')
  assert.match(textContent(profileDialog(tree)), /Осталось занятий4/)
  assert.match(textContent(profileDialog(tree)), /\+4 занятий/)
})

test('late history and payment responses do not replace another selected client’s accounting', async () => {
  for (const pendingPayment of [false, true]) {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const { harness } = await startAccountingView(
      {
        getClientAccounting: async (id) => {
          if (id === 'client-1') return pendingPayment ? emptyAccounting() : gate
          return { ...emptyAccounting(), payments: [{ id: 'boris-payment', amount: 8000, lessonsAdded: 8 }] }
        },
        recordPayment: async () => {
          await gate
          return confirmedPayment()
        },
      },
      [accountingClient(), accountingClient('client-2', 'Борис')],
    )
    selectAccountingClient(harness)
    if (pendingPayment) {
      await settle()
      openAndSubmitPayment(harness)
    }
    selectAccountingClient(harness, 'Борис')
    await settle()
    release({ ...emptyAccounting(), payments: [confirmedPayment().payment] })
    await settle()
    const text = textContent(profileDialog(harness.render()))
    assert.match(text, /Борис/)
    assert.match(text, /\+8 занятий/)
    assert.doesNotMatch(text, /\+4 занятий/)
  }
})

test('a payment response from the previous session is ignored', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { harness } = await startAccountingView({
    getClientAccounting: async () => emptyAccounting(),
    recordPayment: async () => {
      await gate
      return confirmedPayment()
    },
  })
  selectAccountingClient(harness)
  await settle()
  openAndSubmitPayment(harness)
  harness.store.authStore.sessionVersion++
  harness.store.authStore.user = { id: 'admin-2' }
  harness.render()
  release()
  await settle()
  const text = textContent(profileDialog(harness.render()))
  assert.doesNotMatch(text, /\+4 занятий/)
  assert.match(text, /Осталось занятий0/)
})

test('switching client cards retains an uncertain payment amount and its original retry key', async () => {
  const attempts = []
  const { harness } = await startAccountingView(
    {
      getClientAccounting: async () => emptyAccounting(),
      recordPayment: async (...args) => {
        attempts.push(args)
        if (attempts.length === 1) throw new Error('unknown result')
        return confirmedPayment()
      },
    },
    [accountingClient(), accountingClient('client-2', 'Борис')],
  )
  selectAccountingClient(harness)
  await settle()
  buttonNamed(harness.render(), 'Продлить абонемент').props.onClick()
  nodes(paymentDialog(harness.render()))
    .find((node) => node.type === 'Input' && node.props.type === 'number')
    .props.onChange({ target: { value: '11000' } })
  buttonNamed(harness.render(), 'Сохранить платёж').props.onClick()
  await settle()
  selectAccountingClient(harness, 'Борис')
  await settle()
  buttonNamed(harness.render(), 'Продлить абонемент').props.onClick()
  selectAccountingClient(harness, 'Анна')
  await settle()
  openAndSubmitPayment(harness)
  await settle()
  assert.deepEqual(attempts[1], attempts[0])
  assert.equal(attempts[1][1], 11000)
})

test('confirmed adjustment is not reported as failed when its combined history refresh is unavailable', async () => {
  let reads = 0
  const { harness } = await startAccountingView({
    getClientAccounting: async () => {
      if (++reads > 1) throw new Error('refresh failed')
      return emptyAccounting()
    },
    recordAdjustment: async () => ({ success: true }),
  })
  selectAccountingClient(harness)
  await settle()
  buttonNamed(harness.render(), 'Корректировка').props.onClick()
  let tree = harness.render()
  const adjustment = () =>
    nodes(tree).find((node) => node.type === 'Dialog' && textContent(node).includes('Сохранить корректировку'))
  nodes(adjustment())
    .find((node) => node.type === 'Input' && node.props.type === 'number')
    .props.onChange({ target: { value: '1' } })
  nodes(adjustment())
    .find((node) => node.type === 'Input' && node.props.placeholder?.includes('смены тарифа'))
    .props.onChange({ target: { value: 'Подтверждённая коррекция' } })
  tree = harness.render()
  buttonNamed(tree, 'Сохранить корректировку').props.onClick()
  await settle()
  tree = harness.render()
  assert.equal(adjustment().props.open, false)
  assert.match(textContent(profileDialog(tree)), /Подтверждённые операции сохранены/)
  assert.doesNotMatch(textContent(adjustment()), /refresh failed|Не удалось сохранить корректировку/)
})

test('an explicit first payment validation rejection unlocks the amount instead of pinning an invalid attempt', async () => {
  const { harness } = await startAccountingView({
    getClientAccounting: async () => emptyAccounting(),
    recordPayment: async () => {
      const error = new Error('Проверьте введённые данные')
      error.code = 'VALIDATION'
      throw error
    },
  })
  selectAccountingClient(harness)
  await settle()
  openAndSubmitPayment(harness)
  await settle()
  const dialog = paymentDialog(harness.render())
  assert.equal(dialog.props.open, true)
  assert.equal(
    nodes(dialog).find((node) => node.type === 'Input' && node.props.type === 'number').props.disabled,
    false,
  )
})

test('a first validation rejection must not unlock a previously uncertain payment attempt on retry', async () => {
  let writes = 0
  const { harness } = await startAccountingView({
    getClientAccounting: async () => emptyAccounting(),
    recordPayment: async () => {
      const error = new Error('unknown result')
      if (++writes > 1) error.code = 'VALIDATION'
      throw error
    },
  })
  selectAccountingClient(harness)
  await settle()
  openAndSubmitPayment(harness)
  await settle()
  buttonNamed(harness.render(), 'Сохранить платёж').props.onClick()
  await settle()
  const dialog = paymentDialog(harness.render())
  assert.equal(dialog.props.open, true)
  assert.equal(nodes(dialog).find((node) => node.type === 'Input' && node.props.type === 'number').props.disabled, true)
})
