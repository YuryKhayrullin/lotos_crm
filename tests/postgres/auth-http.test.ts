import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { hashPassword } from 'better-auth/crypto'
import { validateEnvironment } from '../../scripts/lib/environment.mjs'
import { createPostgresClient } from '../../lib/server/postgres/client'
import { bootstrapAdmin } from '../../lib/server/postgres/accounts'
import { chromium, expect, type Browser, type Page, type Locator } from '@playwright/test'

validateEnvironment(process.env, 'test')
const db = createPostgresClient(process.env)
const origin = new URL(process.env.APP_URL!).origin
const password = randomBytes(24).toString('hex')
const branch = randomUUID(),
  otherBranch = randomUUID()
let child: ChildProcess, adminCookie: string, coachCookie: string, pendingId: string, activeId: string
let browser: Browser | undefined
let browserCoachId: string, browserRetryId: string

const cookieFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
async function post(path: string, body: unknown, cookie = '') {
  return fetch(origin + '/api/' + path, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    redirect: 'error',
  })
}
const crm = (action: string, payload: unknown, cookie = adminCookie) => post('crm', { action, payload }, cookie)

test('real HTML uses fresh nonces, ignores spoofed/prefetch headers and cannot be shared-cached', async () => {
  const nonces = new Set<string>()
  const cases: Array<{ path: string; status: number; headers: Record<string, string> }> = [
    { path: '/', status: 200, headers: {} },
    {
      path: '/',
      status: 200,
      headers: { 'x-nonce': 'attacker-nonce', 'content-security-policy': "script-src 'unsafe-inline'" },
    },
    { path: '/', status: 200, headers: { purpose: 'prefetch', 'next-router-prefetch': '1' } },
    { path: '/register', status: 200, headers: {} },
    { path: '/icon-not-an-asset', status: 404, headers: {} },
  ]
  for (const item of cases) {
    const response = await fetch(origin + item.path, { headers: item.headers })
    assert.equal(response.status, item.status)
    const csp = response.headers.get('content-security-policy') || ''
    const nonce = csp.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1]
    assert.ok(nonce)
    assert.equal(Buffer.from(nonce, 'base64').length, 32)
    assert.equal(nonces.has(nonce), false)
    nonces.add(nonce)
    const html = await response.text()
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)]
    assert.ok(scripts.length)
    for (const script of scripts) assert.ok(script[1].includes('nonce="' + nonce + '"'))
    assert.doesNotMatch(csp.split(';').find((part) => part.trim().startsWith('script-src ')) || '', /unsafe-/)
    assert.match(response.headers.get('cache-control') || '', /no-store/)
    assert.doesNotMatch(html, /attacker-nonce|_vercel\/insights/)
  }
})

test('real HTTP health is no-store and generic, with baseline browser protection', async () => {
  for (const [path, expected] of [
    ['live', 'ok'],
    ['ready', 'ready'],
  ] as const) {
    const response = await fetch(origin + '/api/health/' + path)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: expected })
    assert.match(response.headers.get('cache-control') || '', /no-store/)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.match(response.headers.get('content-security-policy') || '', /object-src 'none'/)
    assert.equal(response.headers.has('x-powered-by'), false)
  }
})

before(async () => {
  // Never attach tests to an existing development/production listener.
  await new Promise<void>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', () => reject(new Error('Test port is unavailable; existing server is left untouched')))
    probe.listen({ port: Number(new URL(origin).port), host: '127.0.0.1', exclusive: true }, () => {
      probe.close((error) => (error ? reject(error) : resolve()))
    })
  })
  await bootstrapAdmin(db, { username: 'http-test-admin', name: 'HTTP test administrator', password })
  await db.branch.createMany({
    data: [
      { id: branch, name: 'HTTP Pool A', address: 'Fictional' },
      { id: otherBranch, name: 'HTTP Pool B', address: 'Fictional' },
    ],
  })
  for (const status of ['active', 'pending'] as const) {
    const user = await db.user.create({
      data: {
        username: 'http-' + status + '-coach',
        name: 'HTTP test coach',
        status,
        branchId: status === 'active' ? branch : null,
      },
    })
    await db.account.create({
      data: { userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) },
    })
    if (status === 'pending') pendingId = user.id
    else activeId = user.id
  }
  if (process.env.AUTH_BROWSER_TESTS === 'true') {
    for (const username of ['browser-coach', 'browser-retry']) {
      const user = await db.user.create({
        data: { username, name: 'Fictional browser coach', status: 'active', branchId: branch },
      })
      await db.account.create({
        data: { userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) },
      })
      if (username === 'browser-coach') browserCoachId = user.id
      else browserRetryId = user.id
    }
    browser = await chromium.launch()
  }
  child = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', new URL(origin).port],
    {
      cwd: process.cwd(),
      stdio: 'ignore',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        CRM_BACKEND: 'postgres',
        GAS_WEBAPP_URL: '',
        GAS_HMAC_SECRET: '',
        SESSION_SECRET: '',
        UPSTASH_REDIS_REST_URL: '',
        UPSTASH_REDIS_REST_TOKEN: '',
        COACH_REGISTRATION_ENABLED: 'true',
      },
    },
  )
  let started = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) break
    try {
      if ((await fetch(origin, { signal: AbortSignal.timeout(500) })).ok) {
        started = true
        break
      }
    } catch {}
    await delay(250)
  }
  assert.ok(started, 'isolated production Next.js server starts from the prebuilt artifact')
  const admin = await post('auth/login', { username: 'http-test-admin', password })
  assert.equal(admin.status, 200)
  adminCookie = cookieFrom(admin)
  const coach = await post('auth/login', { username: 'http-active-coach', password })
  assert.equal(coach.status, 200)
  coachCookie = cookieFrom(coach)
})

after(async () => {
  await browser?.close()
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt++) await delay(100)
    if (child.exitCode === null) child.kill('SIGKILL') // Only this suite's own PID.
  }
  await db.$disconnect()
})

test('real Next routes authenticate both workspaces with the existing session/bootstrap contract', async () => {
  for (const [cookie, role] of [
    [adminCookie, 'admin'],
    [coachCookie, 'coach'],
  ]) {
    const response = await fetch(origin + '/api/auth/session', { headers: { cookie } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-crm-backend'), 'postgres')
    assert.equal((await response.json()).user.role, role)
  }
  const boot = await crm('getBootstrapData', { includeCoaches: false, branchId: otherBranch }, coachCookie)
  assert.equal(boot.status, 200)
  const data = await boot.json()
  assert.equal(data.branches.length, 1)
  assert.equal(data.branches[0].id, branch)
  assert.equal(data.branches[0].name, 'HTTP Pool A')
  assert.equal('coachAccounts' in data, false)
  assert.equal((await crm('getUsers', {}, coachCookie)).status, 403)
  assert.equal((await crm('getUsers', {})).status, 200)
})

test('real HTTP enforces UTF-8 and chunked request limits BEFORE JSON parsing', async () => {
  const oversized = JSON.stringify({ username: 'я'.repeat(9000), password: 'not-a-credential' })
  assert.ok(Buffer.byteLength(oversized, 'utf8') > 16_384)
  const responses = [
    await fetch(origin + '/api/auth/login', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: oversized,
    }),
    await fetch(origin + '/api/auth/login', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(4096).fill(32))
          controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
  ]
  for (const response of responses) {
    assert.equal(response.status, 413)
    const body = await response.json()
    assert.equal(body.code, 'PAYLOAD_TOO_LARGE')
    assert.doesNotMatch(JSON.stringify(body), /not-a-credential|я{10}/)
  }
})

test(
  'real HTTP parallel read smoke preserves account isolation without errors or growing response sizes',
  { timeout: 60_000 },
  async () => {
    const latencies: number[] = []
    let largestResponseBytes = 0
    const started = performance.now()
    await Promise.all(
      Array.from({ length: 4 }, async (_, worker) => {
        const coach = worker % 2 === 1
        for (let round = 0; round < 35; round++) {
          const requestStarted = performance.now()
          const response = await fetch(origin + '/api/auth/session', {
            headers: { cookie: coach ? coachCookie : adminCookie },
            signal: AbortSignal.timeout(10_000),
          })
          assert.equal(response.status, 200)
          const text = await response.text()
          const data = JSON.parse(text)
          assert.equal(data.user.role, coach ? 'coach' : 'admin')
          assert.equal(data.user.branchId, coach ? branch : null)
          assert.equal('password' in data.user || 'passwordHash' in data.user, false)
          largestResponseBytes = Math.max(largestResponseBytes, Buffer.byteLength(text))
          latencies.push(performance.now() - requestStarted)
          await delay(50)
        }
      }),
    )
    latencies.sort((left, right) => left - right)
    const quantile = (p: number) => latencies[Math.ceil(latencies.length * p) - 1]
    assert.equal(latencies.length, 140)
    assert.ok(largestResponseBytes < 4096)
    mkdirSync('.artifacts', { recursive: true, mode: 0o700 })
    writeFileSync(
      '.artifacts/http-load-latest.json',
      JSON.stringify(
        {
          scope: 'Local production Next HTTP + disposable PostgreSQL; small auth fixture, not VPS/SLO/soak',
          concurrency: 4,
          successfulRequests: latencies.length,
          failedRequests: 0,
          elapsedMs: Math.round(performance.now() - started),
          p50Ms: quantile(0.5),
          p95Ms: quantile(0.95),
          p99Ms: quantile(0.99),
          largestResponseBytes,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )
  },
)

test('real pending activation and reset revoke cookies across independently instantiated Next services', async () => {
  assert.equal((await post('auth/login', { username: 'http-pending-coach', password })).status, 401)
  assert.equal(
    (await crm('assignUserBranch', { userId: pendingId, branchId: branch, requestId: randomUUID() })).status,
    200,
  )
  assert.equal((await crm('activateUser', { userId: pendingId, requestId: randomUUID() })).status, 200)
  const logged = await post('auth/login', { username: 'http-pending-coach', password })
  assert.equal(logged.status, 200)
  const cookie = cookieFrom(logged)
  const newPassword = randomBytes(24).toString('hex')
  assert.equal(
    (await crm('resetCoachPassword', { userId: pendingId, newPassword, requestId: randomUUID() })).status,
    200,
  )
  assert.equal((await fetch(origin + '/api/auth/session', { headers: { cookie } })).status, 401)
  assert.equal((await post('auth/login', { username: 'http-pending-coach', password })).status, 401)
  assert.equal((await post('auth/login', { username: 'http-pending-coach', password: newPassword })).status, 200)
})

test('real API rejects legacy cookies, spoofed permissions and raw auth endpoints without GAS fallback', async () => {
  assert.equal(
    (await fetch(origin + '/api/auth/session', { headers: { cookie: 'lotos_crm_session=old-gas-jwt' } })).status,
    401,
  )
  assert.equal((await post('auth/sign-up/email', { role: 'admin', password })).status, 404)
  assert.equal(
    (await post('crm', { action: 'getUsers', payload: {}, auth: { role: 'admin' } }, coachCookie)).status,
    400,
  )
  const unsupported = await crm('recordPayment', { requestId: randomUUID() })
  assert.equal(unsupported.status, 400)
  assert.equal((await unsupported.json()).code, 'VALIDATION')
})

test('real proxy-facing API requires trusted origin and logout removes the database session', async () => {
  const denied = await fetch(origin + '/api/crm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'https://evil.example' },
    body: JSON.stringify({ action: 'deactivateUser', payload: { userId: activeId, requestId: randomUUID() } }),
  })
  assert.equal(denied.status, 403)
  const logout = await post('auth/logout', {}, coachCookie)
  assert.equal(logout.status, 200)
  assert.equal((await fetch(origin + '/api/auth/session', { headers: { cookie: coachCookie } })).status, 401)
})

// These run only via the guarded browser command, in the SAME isolated DB and
// own production server as the HTTP suite. No mock auth, real user, saved auth
// state, screenshots containing credentials or external requests are needed.
if (process.env.AUTH_BROWSER_TESTS === 'true') {
  test('browser CSP blocks injected inline scripts and event handlers while login remains functional', async () => {
    assert.ok(browser)
    const context = await browser.newContext()
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      // Parse malicious HTML with the policy from a REAL Next response. Using
      // DevTools evaluate() to construct scripts can bypass browser CSP checks
      // and is not a faithful simulation of server-rendered injected markup.
      const policy = (await fetch(origin)).headers.get('content-security-policy')!
      await context.route(origin + '/csp-injection-fixture', (route) =>
        route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html', 'content-security-policy': policy },
          body: '<!doctype html><html><head><script>window.lotosCspProbe = true</script></head><body><button onclick="window.lotosCspProbe = true">CSP probe</button></body></html>',
        }),
      )
      await page.addInitScript(() => {
        const target = window as typeof window & { cspViolations?: string[] }
        target.cspViolations = []
        document.addEventListener('securitypolicyviolation', (event) => {
          target.cspViolations!.push(event.effectiveDirective)
        })
      })
      await page.goto(origin + '/csp-injection-fixture')
      await page.getByRole('button', { name: 'CSP probe', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => (window as typeof window & { cspViolations: string[] }).cspViolations.length))
        .toBeGreaterThanOrEqual(2)
      assert.equal(
        await page.evaluate(() => (window as typeof window & { lotosCspProbe?: boolean }).lotosCspProbe),
        undefined,
      )
      await page.goto(origin)
      await expect(page.getByText('Вход в CRM', { exact: true })).toBeVisible()
      assert.deepEqual(
        await page.evaluate(() => (window as typeof window & { cspViolations: string[] }).cspViolations),
        [],
      )
      await page.getByRole('textbox', { name: 'Логин', exact: true }).fill('http-test-admin')
      await page.getByLabel('Пароль', { exact: true }).fill(password)
      await page.getByLabel('Пароль', { exact: true }).press('Enter')
      await expect(page.getByText('Администрирование', { exact: true }).first()).toBeVisible()
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  async function focusTrap(page: Page, dialog: Locator) {
    await expect(dialog).toBeVisible()
    const title = await dialog.getByRole('heading').first().textContent()
    // Visibility can precede Base UI's focus handoff/portal transition. Wait
    // for the initial handoff before sending real keyboard navigation.
    await expect
      .poll(() => dialog.evaluate((node) => node.contains(document.activeElement)), {
        message: 'Initial focus must enter ' + title,
      })
      .toBe(true)
    for (const key of ['Tab', 'Shift+Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab']) {
      await page.keyboard.press(key)
      await expect
        .poll(() => dialog.evaluate((node) => node.contains(document.activeElement)), {
          message: 'Focus must stay in ' + title + ' after ' + key,
        })
        .toBe(true)
    }
  }
  async function workspace(viewport = { width: 1440, height: 1000 }, timezoneId = 'Europe/Moscow') {
    assert.ok(browser)
    const context = await browser.newContext({ viewport, timezoneId })
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    )
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    const runtimeErrors: string[] = []
    page.on('pageerror', (error) => runtimeErrors.push(error.message))
    await page.goto(origin)
    await expect(page.getByText('Вход в CRM', { exact: true })).toBeVisible()
    const login = async (username: string, pass = password) => {
      await page.getByRole('textbox', { name: 'Логин', exact: true }).fill(username)
      await page.getByLabel('Пароль', { exact: true }).fill(pass)
      await page.getByLabel('Пароль', { exact: true }).press('Enter')
    }
    return { context, page, login, runtimeErrors }
  }

  test(
    'browser admin login via Enter, reload and logout render the real workspace without hook errors',
    { timeout: 60_000 },
    async () => {
      const { context, page, login, runtimeErrors } = await workspace()
      try {
        await login('http-test-admin', password + '-wrong')
        await expect(page.locator('form').getByRole('alert')).toHaveText('Неверный логин или пароль')
        await login('http-test-admin')
        await expect(page.getByText('Администрирование', { exact: true }).first()).toBeVisible()
        await page.getByRole('button', { name: 'Тренеры', exact: true }).click()
        await expect(page.locator('[data-trainer-id="' + browserCoachId + '"]')).toBeVisible()
        await page.reload()
        await expect(page.getByText('Администрирование', { exact: true }).first()).toBeVisible()
        const cookies = await context.cookies()
        assert.ok(cookies.some((cookie) => cookie.name === 'lotos.session_token' && cookie.httpOnly))
        assert.equal((await page.evaluate(() => document.cookie)).includes('lotos.session_token'), false)
        await page.getByRole('button', { name: 'Выйти', exact: true }).first().click()
        await expect(page.getByText('Вход в CRM', { exact: true })).toBeVisible()
        assert.deepEqual(runtimeErrors, [])
      } finally {
        await context.close()
      }
    },
  )

  test(
    'mobile browser coach sees only its branch/workspace and cannot call admin API directly',
    { timeout: 60_000 },
    async () => {
      const { context, page, login, runtimeErrors } = await workspace({ width: 390, height: 844 })
      try {
        await login('browser-coach')
        await expect(page.getByText('Ваш день — в одном месте.', { exact: true })).toBeVisible()
        await expect(page.getByText('HTTP Pool A', { exact: true }).first()).toBeVisible()
        await expect(page.getByRole('button', { name: 'Тренеры', exact: true })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Финансы', exact: true })).toHaveCount(0)
        const denied = await page.evaluate(async () => {
          const response = await fetch('/api/crm', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'getUsers', payload: {} }),
          })
          return { status: response.status, code: (await response.json()).code }
        })
        assert.deepEqual(denied, { status: 403, code: 'FORBIDDEN' })
        await page.reload()
        await expect(page.getByText('Ваш день — в одном месте.', { exact: true })).toBeVisible()
        assert.deepEqual(runtimeErrors, [])
      } finally {
        await context.close()
      }
    },
  )

  test(
    'admin browser session-revoke button invalidates another browser without disabling the coach',
    { timeout: 60_000 },
    async () => {
      const admin = await workspace()
      const coach = await workspace()
      try {
        await admin.login('http-test-admin')
        await coach.login('browser-coach')
        await expect(coach.page.getByText('Ваш день — в одном месте.', { exact: true })).toBeVisible()
        await admin.page.getByRole('button', { name: 'Тренеры', exact: true }).click()
        admin.page.on('dialog', (dialog) => dialog.accept())
        const row = admin.page.locator('[data-trainer-id="' + browserCoachId + '"]')
        await row.locator('summary').filter({ hasText: 'Управление тренером' }).click()
        await row.getByRole('button', { name: 'Завершить сессии', exact: true }).click()
        await expect(
          admin.page.getByText('Все сессии тренера завершены. Аккаунт остаётся активным.', { exact: true }),
        ).toBeVisible()
        await coach.page.reload()
        await expect(coach.page.getByText('Вход в CRM', { exact: true })).toBeVisible()
        assert.equal((await db.user.findUniqueOrThrow({ where: { id: browserCoachId } })).status, 'active')
        await coach.login('browser-coach')
        await expect(coach.page.getByText('Ваш день — в одном месте.', { exact: true })).toBeVisible()
        assert.deepEqual([...admin.runtimeErrors, ...coach.runtimeErrors], [])
      } finally {
        await Promise.all([admin.context.close(), coach.context.close()])
      }
    },
  )

  test(
    'browser retries a password reset after a lost committed acknowledgement with the SAME key',
    { timeout: 60_000 },
    async () => {
      const admin = await workspace()
      const attempts: string[] = []
      const newPassword = randomBytes(24).toString('hex')
      try {
        await admin.login('http-test-admin')
        await admin.page.getByRole('button', { name: 'Тренеры', exact: true }).click()
        await admin.page.route('**/api/crm', async (route) => {
          const body = route.request().postDataJSON()
          if (body.action !== 'resetCoachPassword') return route.continue()
          attempts.push(body.payload.requestId)
          const committed = await route.fetch()
          assert.equal(committed.status(), 200)
          if (attempts.length === 1)
            await route.fulfill({
              status: 408,
              contentType: 'application/json',
              body: JSON.stringify({ status: 'error', code: 'TIMEOUT', message: 'Тест: ответ потерян после записи' }),
            })
          else await route.fulfill({ response: committed })
        })
        const row = admin.page.locator('[data-trainer-id="' + browserRetryId + '"]')
        await row.locator('summary').filter({ hasText: 'Управление тренером' }).click()
        await row.locator('summary').filter({ hasText: 'Изменить пароль' }).click()
        await row.getByLabel('Новый пароль для browser-retry', { exact: true }).fill(newPassword)
        await row.getByRole('button', { name: 'Изменить пароль', exact: true }).click()
        await expect(admin.page.getByText('Тест: ответ потерян после записи', { exact: true })).toBeVisible()
        const firstVersion = (await db.user.findUniqueOrThrow({ where: { id: browserRetryId } })).authVersion
        await row.getByRole('button', { name: 'Изменить пароль', exact: true }).click()
        await expect(row.getByLabel('Новый пароль для browser-retry', { exact: true })).toHaveValue('')
        assert.equal(attempts.length, 2)
        assert.equal(attempts[0], attempts[1])
        assert.equal((await db.user.findUniqueOrThrow({ where: { id: browserRetryId } })).authVersion, firstVersion)
        assert.equal(await db.mutationRequest.count({ where: { requestKey: attempts[0] } }), 1)
        assert.equal((await post('auth/login', { username: 'browser-retry', password: newPassword })).status, 200)
        assert.deepEqual(admin.runtimeErrors, [])
      } finally {
        await admin.context.close()
      }
    },
  )

  test(
    'browser catalogue flow creates a branch/client, edits, archives, restores and deletes the empty card',
    { timeout: 60_000 },
    async () => {
      const admin = await workspace()
      try {
        await admin.login('http-test-admin')
        await admin.page.getByRole('button', { name: 'Филиалы', exact: true }).click()
        await focusTrap(admin.page, admin.page.getByRole('dialog', { name: 'Управление филиалами', exact: true }))
        await admin.page.getByPlaceholder('Название филиала', { exact: true }).fill('Browser fictional pool')
        await admin.page.getByPlaceholder('Адрес филиала', { exact: true }).fill('Fictional test address')
        await admin.page.getByRole('button', { name: 'Создать филиал', exact: true }).click()
        await expect(admin.page.getByPlaceholder('Название филиала', { exact: true })).toBeHidden()
        await admin.page.getByRole('button', { name: 'Клиенты и дети', exact: true }).click()
        await admin.page.getByRole('button', { name: 'Добавить клиента', exact: true }).click()
        const create = admin.page.getByRole('dialog', { name: 'Новый клиент', exact: true })
        await focusTrap(admin.page, create)
        await create.getByLabel('Имя ребёнка', { exact: true }).fill('Browser fictional pupil')
        await create.getByLabel('Имя родителя', { exact: true }).fill('Fictional parent')
        await create.getByLabel('Телефон', { exact: true }).fill('79990000000')
        await create.getByLabel('Секция', { exact: true }).selectOption('синхронное плавание')
        await create.getByLabel('Занятий в неделю', { exact: true }).selectOption('3')
        await expect(create.getByPlaceholder('Введите сумму в рублях')).toBeEnabled()
        await create.getByRole('button', { name: 'Создать профиль клиента', exact: true }).click()
        await expect(create).toBeHidden()
        const row = () => admin.page.getByRole('row').filter({ hasText: 'Browser fictional pupil' })
        await row().click()
        let profile = admin.page.getByRole('dialog', { name: 'Browser fictional pupil', exact: true })
        await profile.locator('summary').filter({ hasText: 'Управление карточкой' }).click()
        await profile.getByRole('button', { name: 'Редактировать', exact: true }).click()
        const edit = admin.page.getByRole('dialog', { name: 'Редактирование клиента', exact: true })
        await focusTrap(admin.page, edit)
        await edit.getByLabel('Имя ребёнка', { exact: true }).fill('Browser renamed pupil')
        await edit.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
        await expect(edit).toBeHidden()
        profile = admin.page.getByRole('dialog', { name: 'Browser renamed pupil', exact: true })
        await expect(profile).toBeVisible()
        admin.page.on('dialog', (dialog) => dialog.accept())
        await profile.getByRole('button', { name: 'В архив', exact: true }).click()
        await expect(profile).toBeHidden()
        await admin.page.getByRole('row').filter({ hasText: 'Browser renamed pupil' }).click()
        profile = admin.page.getByRole('dialog', { name: 'Browser renamed pupil', exact: true })
        await profile.locator('summary').filter({ hasText: 'Управление карточкой' }).click()
        await profile.getByRole('button', { name: 'Восстановить', exact: true }).click()
        await expect(profile).toBeHidden()
        await admin.page.getByRole('row').filter({ hasText: 'Browser renamed pupil' }).click()
        profile = admin.page.getByRole('dialog', { name: 'Browser renamed pupil', exact: true })
        await profile.locator('summary').filter({ hasText: 'Управление карточкой' }).click()
        await expect(profile.getByRole('button', { name: 'Удалить пустую карточку', exact: true })).toBeEnabled()
        await profile.getByRole('button', { name: 'Удалить пустую карточку', exact: true }).click()
        await expect(profile).toBeHidden()
        assert.equal(await db.client.count({ where: { childName: 'Browser renamed pupil' } }), 0)
        assert.deepEqual(admin.runtimeErrors, [])
      } finally {
        await admin.context.close()
      }
    },
  )

  test(
    'browser coach creation with access survives a lost committed reply without duplicate profile or account',
    { timeout: 60_000 },
    async () => {
      const admin = await workspace(),
        keys: string[] = []
      const temporaryPassword = randomBytes(24).toString('hex')
      try {
        await admin.login('http-test-admin')
        await admin.page.getByRole('button', { name: 'Тренеры', exact: true }).click()
        await admin.page.getByRole('button', { name: 'Добавить тренера', exact: true }).click()
        const dialog = admin.page.getByRole('dialog', { name: 'Новый тренер', exact: true })
        await focusTrap(admin.page, dialog)
        await dialog.getByPlaceholder('Имя', { exact: true }).fill('Browser')
        await dialog.getByPlaceholder('Фамилия', { exact: true }).fill('Fictional')
        await dialog.getByRole('combobox', { name: 'Филиал тренера', exact: true }).click()
        await admin.page.getByRole('option', { name: 'HTTP Pool A', exact: true }).click()
        await dialog.getByPlaceholder('Логин тренера', { exact: true }).fill('browser-created-coach')
        await dialog.getByPlaceholder('Временный пароль (минимум 8 символов)', { exact: true }).fill(temporaryPassword)
        await admin.page.route('**/api/crm', async (route) => {
          const data = route.request().postDataJSON()
          if (data.action !== 'createCoach') return route.continue()
          keys.push(data.payload.requestId)
          const response = await route.fetch()
          assert.equal(response.status(), 200)
          if (keys.length === 1)
            await route.fulfill({
              status: 408,
              contentType: 'application/json',
              body: JSON.stringify({ status: 'error', message: 'Тест: создание тренера не подтверждено' }),
            })
          else await route.fulfill({ response })
        })
        await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click()
        await expect(dialog.getByText('Тест: создание тренера не подтверждено', { exact: true })).toBeVisible()
        await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click()
        await expect(dialog).toBeHidden()
        assert.equal(keys.length, 2)
        assert.equal(keys[0], keys[1])
        assert.equal(await db.coach.count({ where: { name: 'Browser Fictional' } }), 1)
        assert.equal(await db.user.count({ where: { username: 'browser-created-coach' } }), 1)
        assert.equal(
          (await post('auth/login', { username: 'browser-created-coach', password: temporaryPassword })).status,
          200,
        )
        assert.deepEqual(admin.runtimeErrors, [])
      } finally {
        await admin.context.close()
      }
    },
  )
  test(
    'browser coach creates an assigned lesson, recovers a committed lost reply after reload and corrects it',
    { timeout: 90_000 },
    async () => {
      await db.authRateBucket.deleteMany() // disposable fixture only
      const teacher = await workspace()
      try {
        await teacher.login('browser-coach')
        await expect(teacher.page.getByText('Ваш день — в одном месте.', { exact: true })).toBeVisible()
        const adminId = (await db.user.findUniqueOrThrow({ where: { username: 'http-test-admin' } })).id
        const client = await db.client.create({
          data: {
            branchId: branch,
            childName: 'Browser attendance pupil',
            parentName: 'Private parent',
            totalLessons: 1,
            remainingLessons: 1,
            ledgerVersion: 1,
          },
        })
        const marker = await db.mutationRequest.create({
          data: {
            actorId: adminId,
            requestKey: randomUUID(),
            action: 'fixture',
            fingerprint: 'b'.repeat(64),
            result: {},
          },
        })
        await db.lessonLedgerEntry.create({
          data: {
            clientId: client.id,
            branchId: branch,
            actorId: adminId,
            requestId: marker.id,
            type: 'opening_balance',
            sequence: 1,
            lessonsDelta: 1,
            totalLessonsDelta: 1,
            balanceBefore: 0,
            balanceAfter: 1,
            totalBefore: 0,
            totalAfter: 1,
            reason: 'Fictional browser fixture',
          },
        })
        await teacher.page.getByRole('button', { name: 'Открыть расписание', exact: true }).click()
        await teacher.page.getByRole('button', { name: 'Новое занятие', exact: true }).click()
        let dialog = teacher.page.getByRole('dialog')
        const tomorrow = await teacher.page.evaluate(() => {
          const date = new Date()
          date.setDate(date.getDate() + 1)
          return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        })
        await dialog.getByLabel('Дата', { exact: true }).fill(tomorrow)
        await dialog.getByRole('combobox', { name: 'Время занятия', exact: true }).click()
        await teacher.page.getByRole('option', { name: '17:00', exact: true }).click()
        await dialog.getByRole('button', { name: 'Выбрать клиентов', exact: true }).click()
        await dialog.getByRole('checkbox', { name: /Browser attendance pupil/ }).check()
        await dialog.getByRole('button', { name: 'Создать и записать (1)', exact: true }).click()
        await expect(dialog).toBeHidden()
        const created = await db.lesson.findFirstOrThrow({
          where: { enrollments: { some: { clientId: client.id } } },
          include: { coach: true },
        })
        assert.equal(created.coach.userId, browserCoachId)
        await teacher.page.getByRole('button', { name: 'Неделя', exact: true }).click()
        // Tomorrow may be the next calendar week.
        if (new Date(tomorrow + 'T12:00:00').getDay() === 1)
          await teacher.page
            .getByRole('button', { name: /Следующ/ })
            .last()
            .click()
        await teacher.page.getByRole('button', { name: 'Изменить', exact: true }).last().click()
        dialog = teacher.page.getByRole('dialog')
        await expect(dialog.getByRole('button', { name: 'Удалить пустое занятие', exact: true })).toHaveCount(0)
        await focusTrap(teacher.page, dialog)
        await dialog.getByLabel('Бассейн', { exact: true }).fill('Browser fictional updated pool')
        await dialog.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
        await expect(dialog).toBeHidden()
        assert.equal((await db.lesson.findUniqueOrThrow({ where: { id: created.id } })).version, 2)
        await teacher.page.getByText('Плавание', { exact: true }).last().click()
        dialog = teacher.page.getByRole('dialog')
        await focusTrap(teacher.page, dialog)
        await dialog.getByRole('button', { name: 'Пришёл', exact: true }).click()
        const keys: string[] = []
        await teacher.page.route('**/api/crm', async (route) => {
          const input = route.request().postDataJSON()
          if (input.action !== 'recordBulkAttendance') return route.continue()
          keys.push(input.payload.requestId)
          const response = await route.fetch()
          assert.equal(response.status(), 200)
          if (keys.length === 1)
            await route.fulfill({
              status: 408,
              contentType: 'application/json',
              body: JSON.stringify({ status: 'error', message: 'Fictional lost committed reply' }),
            })
          else await route.fulfill({ response })
        })
        await dialog.getByRole('button', { name: /^Сохранить/ }).click()
        await expect(dialog.getByRole('button', { name: 'Повторить сохранение', exact: true })).toBeVisible()
        await teacher.page.reload()
        await teacher.page.getByRole('button', { name: 'Открыть расписание', exact: true }).click()
        await teacher.page.getByRole('button', { name: 'Неделя', exact: true }).click()
        if (new Date(tomorrow + 'T12:00:00').getDay() === 1)
          await teacher.page
            .getByRole('button', { name: /Следующ/ })
            .last()
            .click()
        await teacher.page.getByText('Плавание', { exact: true }).last().click()
        dialog = teacher.page.getByRole('dialog')
        await dialog.getByRole('button', { name: 'Повторить сохранение', exact: true }).click()
        await expect(dialog).toBeHidden()
        assert.equal(keys.length, 2)
        assert.equal(keys[0], keys[1])
        assert.equal(await db.attendanceEvent.count({ where: { clientId: client.id } }), 1)
        await teacher.page.getByText('Плавание', { exact: true }).last().click()
        dialog = teacher.page.getByRole('dialog')
        await dialog.getByRole('button', { name: 'Не пришёл', exact: true }).click()
        await dialog.getByRole('button', { name: /^Сохранить/ }).click()
        await expect(dialog).toBeHidden()
        assert.equal((await db.client.findUniqueOrThrow({ where: { id: client.id } })).remainingLessons, 1)
        assert.equal(await db.attendanceEvent.count({ where: { clientId: client.id } }), 2)
        await teacher.page.getByRole('button', { name: 'Изменить', exact: true }).last().click()
        dialog = teacher.page.getByRole('dialog')
        await dialog.getByLabel('Причина отмены', { exact: true }).fill('Test cancel')
        await dialog.getByRole('button', { name: 'Отменить занятие', exact: true }).click()
        await expect(dialog.getByRole('alert')).toHaveText('Отмена занятия с отметками запрещена, включая отсутствие')
        assert.equal((await db.lesson.findUniqueOrThrow({ where: { id: created.id } })).status, 'scheduled')
        assert.deepEqual(teacher.runtimeErrors, [])
      } finally {
        await teacher.context.close()
      }
    },
  )
  test(
    'browser calendar and creation use Moscow date while browser is in Los Angeles',
    { timeout: 60000 },
    async () => {
      await db.authRateBucket.deleteMany()
      const coach = await db.coach.create({ data: { branchId: branch, name: 'Timezone fictional coach' } })
      await db.coachBranch.create({ data: { coachId: coach.id, branchId: branch } })
      const owner = await db.user.findUniqueOrThrow({ where: { username: 'http-test-admin' } })
      await db.lesson.create({
        data: {
          branchId: branch,
          coachId: coach.id,
          createdById: owner.id,
          title: 'Timezone proof lesson',
          category: 'swimming',
          localDate: new Date('2026-10-09'),
          timeZone: 'Europe/Moscow',
          startsAt: new Date('2026-10-09T14:00:00Z'),
          endsAt: new Date('2026-10-09T15:00:00Z'),
          rosterConfirmed: true,
        },
      })
      const admin = await workspace({ width: 1440, height: 1000 }, 'America/Los_Angeles')
      try {
        await admin.page.clock.install({ time: new Date('2026-10-08T21:30:00Z') })
        await admin.login('http-test-admin')
        await admin.page.getByRole('button', { name: 'Расписание', exact: true }).click()
        await expect(admin.page.getByText('Timezone proof lesson', { exact: true })).toBeVisible()
        await admin.page.getByRole('button', { name: 'Новое занятие', exact: true }).click()
        const dialog = admin.page.getByRole('dialog', { name: 'Новое занятие', exact: true })
        await focusTrap(admin.page, dialog)
        await expect(dialog.locator('input[type=date]').first()).toHaveValue('2026-10-09')
        await admin.page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        assert.deepEqual(admin.runtimeErrors, [])
      } finally {
        await admin.context.close()
      }
    },
  )
  test(
    'browser without receipts shows disabled status and makes no document requests',
    { timeout: 60000 },
    async () => {
      await db.authRateBucket.deleteMany()
      const card = await db.client.create({
        data: { branchId: branch, childName: 'Disabled receipts fictional pupil', parentName: 'Fictional parent' },
      })
      const admin = await workspace({ width: 1440, height: 1000 })
      let documentRequests = 0
      // Advertise the disabled staging capability on genuine Next/SQL responses.
      // Separate router tests verify backend denial for the same configuration.
      await admin.page.route('**/api/crm', async (route) => {
        const response = await route.fetch()
        await route.fulfill({ response, headers: { ...response.headers(), 'x-crm-receipt-max-bytes': '0' } })
      })
      admin.page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/receipts/')) documentRequests++
      })
      try {
        await admin.login('http-test-admin')
        await admin.page.getByRole('button', { name: 'Клиенты и дети', exact: true }).click()
        await admin.page.getByRole('button', { name: new RegExp(card.childName) }).click()
        const panel = admin.page.getByRole('region', { name: 'Квитанция клиента' })
        await expect(panel).toContainText('Квитанции отключены на тестовом стенде')
        await expect(panel.locator('input[type=file]')).toHaveCount(0)
        await expect(panel.getByRole('button')).toHaveCount(0)
        await expect(panel.getByRole('link')).toHaveCount(0)
        assert.equal(documentRequests, 0)
        assert.deepEqual(admin.runtimeErrors, [])
      } finally {
        // Finish outstanding mocked-header responses before disposing the browser
        // request context; otherwise a route.fetch can reject after test teardown.
        await admin.page.unrouteAll({ behavior: 'wait' })
        await admin.context.close()
      }
    },
  )

  test(
    'browser receipt resumes a persisted SQL-failed upload after reload without selecting another file',
    { timeout: 90000 },
    async () => {
      await db.authRateBucket.deleteMany()
      const admin = await workspace({ width: 390, height: 844 })
      const owner = await db.user.findUniqueOrThrow({ where: { username: 'http-test-admin' } })
      const card = await db.client.create({
        data: { branchId: branch, childName: 'Recovery fictional pupil', parentName: 'Fictional parent' },
      })
      const sharpModule = await import('sharp')
      const png = await sharpModule
        .default({ create: { width: 2, height: 2, channels: 3, background: '#00bbaa' } })
        .png()
        .toBuffer()
      try {
        await admin.login('http-test-admin')
        // Mobile navigation exposes a menu rather than the desktop sidebar.
        await admin.page.getByRole('button', { name: 'Открыть меню', exact: true }).click()
        await admin.page.getByRole('button', { name: 'Клиенты и дети', exact: true }).click()
        await admin.page.getByRole('button', { name: new RegExp(card.childName) }).click()
        let panel = admin.page.getByRole('region', { name: 'Квитанция клиента' })
        await panel
          .getByLabel('Файл квитанции', { exact: true })
          .setInputFiles({ name: 'Reload receipt.png', mimeType: 'image/png', buffer: png })
        await db.$executeRawUnsafe(
          "CREATE FUNCTION test_browser_file_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='uploadReceipt' THEN RAISE EXCEPTION 'fictional SQL failure'; END IF; RETURN NEW; END $$",
        )
        await db.$executeRawUnsafe(
          'CREATE TRIGGER test_browser_file_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_browser_file_failure()',
        )
        try {
          await panel.getByRole('button', { name: 'Загрузить квитанцию', exact: true }).click()
          await expect(panel.getByRole('button', { name: 'Повторить загрузку', exact: true })).toBeVisible()
        } finally {
          await db.$executeRawUnsafe('DROP TRIGGER test_browser_file_failure ON audit_events')
          await db.$executeRawUnsafe('DROP FUNCTION test_browser_file_failure()')
        }
        const attempt = await db.documentUpload.findFirstOrThrow({
          where: { clientId: card.id, actorId: owner.id, state: 'pending' },
        })
        await admin.page.reload()
        await admin.page.getByRole('button', { name: 'Открыть меню', exact: true }).click()
        await admin.page.getByRole('button', { name: 'Клиенты и дети', exact: true }).click()
        await admin.page.getByRole('button', { name: new RegExp(card.childName) }).click()
        panel = admin.page.getByRole('region', { name: 'Квитанция клиента' })
        await panel.getByRole('button', { name: 'Восстановить загрузку', exact: true }).click()
        await expect(panel.getByRole('link', { name: 'Скачать текущую квитанцию', exact: true })).toBeVisible()
        assert.equal(await db.document.count({ where: { clientId: card.id } }), 1)
        assert.ok(
          await db.mutationRequest.findUnique({
            where: { actorId_requestKey: { actorId: owner.id, requestKey: attempt.requestKey } },
          }),
        )
        assert.equal((await db.client.findUniqueOrThrow({ where: { id: card.id } })).remainingLessons, 0)
        assert.deepEqual(admin.runtimeErrors, [])
      } finally {
        await admin.context.close()
      }
    },
  )

  test(
    'browser recovers a lost committed creation and SQL-failed payment from its own inbox after reload',
    { timeout: 90000 },
    async () => {
      await db.authRateBucket.deleteMany()
      const admin = await workspace()
      const name = 'Inbox fictional pupil'
      let creationKey = ''
      try {
        await admin.login('http-test-admin')
        await admin.page.getByRole('button', { name: 'Клиенты и дети', exact: true }).click()
        await admin.page.getByRole('button', { name: 'Добавить клиента', exact: true }).click()
        const dialog = admin.page.getByRole('dialog', { name: 'Новый клиент', exact: true })
        await dialog.getByLabel('Имя ребёнка', { exact: true }).fill(name)
        await dialog.getByLabel('Имя родителя', { exact: true }).fill('Fictional parent')
        await dialog.getByLabel('Телефон', { exact: true }).fill('79990000000')
        await dialog.getByLabel('Филиал клиента', { exact: true }).selectOption(branch)
        await dialog.getByLabel('Секция', { exact: true }).selectOption('плавание')
        await dialog.getByLabel('Занятий в неделю', { exact: true }).selectOption('1')
        await dialog.getByPlaceholder('Введите сумму в рублях').fill('5500')
        await admin.page.route('**/api/crm', async (route) => {
          const input = route.request().postDataJSON()
          if (input.action !== 'createClient') return route.continue()
          creationKey = input.payload.requestId
          const response = await route.fetch()
          assert.equal(response.status(), 200)
          await route.fulfill({
            status: 408,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'error', message: 'Fictional lost commit reply' }),
          })
        })
        await dialog.getByRole('button', { name: 'Создать профиль клиента', exact: true }).click()
        await expect(dialog.getByRole('button', { name: 'Повторить тот же запрос', exact: true })).toBeVisible()
        await admin.page.reload()
        let inbox = admin.page.getByRole('region', { name: 'Восстановление операций' })
        await inbox
          .locator('div')
          .filter({ has: admin.page.getByText(creationKey, { exact: true }) })
          .getByRole('button', { name: 'Восстановить', exact: true })
          .click()
        await expect(inbox.getByRole('status')).toContainText('Операция подтверждена')
        const card = await db.client.findFirstOrThrow({ where: { childName: name } })
        assert.equal(await db.client.count({ where: { childName: name } }), 1)
        assert.equal(await db.payment.count({ where: { clientId: card.id } }), 1)
        await admin.page.unroute('**/api/crm')
        await inbox.getByRole('button', { name: 'Обновить экран', exact: true }).click()
        await admin.page.getByRole('button', { name: 'Клиенты и дети', exact: true }).click()
        await admin.page.getByRole('row').filter({ hasText: name }).click()
        await admin.page.getByRole('button', { name: 'Продлить абонемент', exact: true }).click()
        const renewal = admin.page.getByRole('dialog', { name: 'Продление абонемента', exact: true })
        await focusTrap(admin.page, renewal)
        await renewal.getByLabel('Сумма нового платежа', { exact: true }).fill('5500')
        await db.$executeRawUnsafe(
          "CREATE FUNCTION test_inbox_payment_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='recordPayment' THEN RAISE EXCEPTION 'fictional failure'; END IF; RETURN NEW; END $$",
        )
        await db.$executeRawUnsafe(
          'CREATE TRIGGER test_inbox_payment_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_inbox_payment_failure()',
        )
        try {
          await renewal.getByRole('button', { name: 'Сохранить платёж', exact: true }).click()
          await expect(renewal.getByRole('alert')).toBeVisible()
          await expect(renewal.getByRole('button', { name: 'Сохранить платёж', exact: true })).toBeEnabled()
        } finally {
          await db.$executeRawUnsafe('DROP TRIGGER test_inbox_payment_failure ON audit_events')
          await db.$executeRawUnsafe('DROP FUNCTION test_inbox_payment_failure()')
        }
        const draft = await db.mutationDraft.findFirstOrThrow({
          where: { action: 'recordPayment', state: 'pending', payload: { path: ['clientId'], equals: card.id } },
        })
        await admin.page.reload()
        inbox = admin.page.getByRole('region', { name: 'Восстановление операций' })
        await inbox
          .locator('div')
          .filter({ has: admin.page.getByText(draft.requestKey, { exact: true }) })
          .getByRole('button', { name: 'Восстановить', exact: true })
          .click()
        await expect(inbox.getByRole('status')).toContainText('Операция подтверждена')
        assert.equal(await db.payment.count({ where: { clientId: card.id } }), 2)
        assert.equal((await db.client.findUniqueOrThrow({ where: { id: card.id } })).remainingLessons, 8)
        assert.deepEqual(admin.runtimeErrors, [])
      } finally {
        await admin.context.close()
      }
    },
  )

  test(
    'browser password reset recovers after reload without storing the plaintext credential',
    { timeout: 90000 },
    async () => {
      await db.authRateBucket.deleteMany()
      const user = await db.user.create({
        data: { username: 'browser-secret-reload', name: 'Fictional', status: 'active', branchId: branch },
      })
      await db.account.create({
        data: { userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) },
      })
      const nextPassword = randomBytes(24).toString('hex')
      const admin = await workspace()
      try {
        await admin.login('http-test-admin')
        await admin.page.getByRole('button', { name: 'Тренеры', exact: true }).click()
        const row = admin.page.locator('[data-trainer-id="' + user.id + '"]')
        await row.locator('summary').filter({ hasText: 'Управление тренером' }).click()
        await row.locator('summary').filter({ hasText: 'Изменить пароль' }).click()
        await row.getByLabel('Новый пароль для ' + user.username, { exact: true }).fill(nextPassword)
        await db.$executeRawUnsafe(
          "CREATE FUNCTION test_reload_password_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='resetCoachPassword' THEN RAISE EXCEPTION 'fictional failure'; END IF; RETURN NEW; END $$",
        )
        await db.$executeRawUnsafe(
          'CREATE TRIGGER test_reload_password_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_reload_password_failure()',
        )
        try {
          await row.getByRole('button', { name: 'Изменить пароль', exact: true }).click()
          await expect(admin.page.getByText('Сервис временно недоступен', { exact: true })).toBeVisible()
        } finally {
          await db.$executeRawUnsafe('DROP TRIGGER test_reload_password_failure ON audit_events')
          await db.$executeRawUnsafe('DROP FUNCTION test_reload_password_failure()')
        }
        const intent = await db.mutationDraft.findFirstOrThrow({
          where: { action: 'resetCoachPassword', payload: { path: ['userId'], equals: user.id } },
        })
        assert.equal(JSON.stringify(intent.payload).includes(nextPassword), false)
        assert.equal(intent.requiresCredential, true)
        await admin.page.reload()
        const inbox = admin.page.getByRole('region', { name: 'Восстановление операций' })
        const attempt = inbox
          .locator('div')
          .filter({ has: admin.page.getByText(intent.requestKey, { exact: true }) })
          .first()
        await expect(attempt.getByRole('button', { name: 'Восстановить', exact: true })).toBeDisabled()
        await attempt.getByLabel('Исходный пароль ' + intent.requestKey, { exact: true }).fill(nextPassword)
        await attempt.getByRole('button', { name: 'Восстановить', exact: true }).click()
        await expect(inbox.getByRole('status')).toContainText('Операция подтверждена')
        assert.equal((await post('auth/login', { username: user.username, password: nextPassword })).status, 200)
        assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).authVersion, 2)
        await expect(inbox.getByRole('heading', { name: 'Восстановление операций' })).toBeFocused()
        assert.deepEqual(admin.runtimeErrors, [])
      } finally {
        await admin.context.close()
      }
    },
  )

  test(
    'browser coach recovers a pending edit after reload and opens lessons with the keyboard',
    { timeout: 90000 },
    async () => {
      await db.authRateBucket.deleteMany()
      const teacher = await workspace()
      const coach = await db.coach.findUniqueOrThrow({ where: { userId: browserCoachId } })
      const owner = await db.user.findUniqueOrThrow({ where: { username: 'http-test-admin' } })
      const day = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date())
      const lesson = await db.lesson.create({
        data: {
          branchId: branch,
          coachId: coach.id,
          createdById: owner.id,
          title: 'Reload editable lesson',
          category: 'swimming',
          localDate: new Date(day),
          timeZone: 'Europe/Moscow',
          startsAt: new Date(day + 'T14:00:00Z'),
          endsAt: new Date(day + 'T15:00:00Z'),
          rosterConfirmed: true,
        },
      })
      try {
        await teacher.login('browser-coach')
        await teacher.page.getByRole('button', { name: 'Открыть расписание', exact: true }).click()
        const open = teacher.page.getByRole('button', { name: /Открыть занятие: Reload editable lesson/ })
        await open.focus()
        await teacher.page.keyboard.press('Enter')
        let dialog = teacher.page.getByRole('dialog')
        await focusTrap(teacher.page, dialog)
        await teacher.page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        await expect(open).toBeFocused()
        const card = teacher.page.locator('[data-slot=card]').filter({ hasText: 'Reload editable lesson' })
        await card.getByRole('button', { name: 'Изменить', exact: true }).click()
        dialog = teacher.page.getByRole('dialog')
        await dialog.getByLabel('Бассейн', { exact: true }).fill('Reload confirmed pool')
        await db.$executeRawUnsafe(
          "CREATE FUNCTION test_reload_edit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='updateLesson' THEN RAISE EXCEPTION 'fictional failure'; END IF; RETURN NEW; END $$",
        )
        await db.$executeRawUnsafe(
          'CREATE TRIGGER test_reload_edit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_reload_edit_failure()',
        )
        try {
          await dialog.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
          await expect(dialog.getByRole('alert')).toHaveText('Сервис временно недоступен')
        } finally {
          await db.$executeRawUnsafe('DROP TRIGGER test_reload_edit_failure ON audit_events')
          await db.$executeRawUnsafe('DROP FUNCTION test_reload_edit_failure()')
        }
        const intent = await db.mutationDraft.findFirstOrThrow({
          where: { action: 'updateLesson', state: 'pending', payload: { path: ['id'], equals: lesson.id } },
        })
        await teacher.page.reload()
        const inbox = teacher.page.getByRole('region', { name: 'Восстановление операций' })
        await inbox
          .locator('div')
          .filter({ has: teacher.page.getByText(intent.requestKey, { exact: true }) })
          .first()
          .getByRole('button', { name: 'Восстановить', exact: true })
          .click()
        await expect(inbox.getByRole('status')).toContainText('Операция подтверждена')
        assert.equal(
          (await db.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).location,
          'Reload confirmed pool',
        )
        assert.equal((await db.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).version, 2)
        assert.deepEqual(teacher.runtimeErrors, [])
      } finally {
        await teacher.context.close()
      }
    },
  )

  test(
    'browser client dialogs trap keyboard focus and return to their opener on Escape',
    { timeout: 90000 },
    async () => {
      await db.authRateBucket.deleteMany()
      const client = await db.client.create({
        data: { branchId: branch, childName: 'Keyboard fictional pupil', parentName: 'Fictional parent' },
      })
      const admin = await workspace()
      try {
        await admin.login('http-test-admin')
        await admin.page.getByRole('button', { name: 'Клиенты и дети', exact: true }).click()
        const opener = admin.page.getByRole('button', { name: 'Открыть карточку: ' + client.childName, exact: true })
        await opener.focus()
        await admin.page.keyboard.press('Enter')
        const profile = admin.page.getByRole('dialog', { name: client.childName, exact: true })
        await focusTrap(admin.page, profile)
        await profile.locator('summary').filter({ hasText: 'Управление карточкой' }).click()
        for (const [button, title] of [
          ['Редактировать', 'Редактирование клиента'],
          ['Корректировка', 'Корректировка абонемента'],
          ['Продлить абонемент', 'Продление абонемента'],
        ]) {
          const trigger = profile.getByRole('button', { name: button, exact: true })
          await trigger.focus()
          await admin.page.keyboard.press('Enter')
          const dialog = admin.page.getByRole('dialog', { name: title, exact: true })
          await focusTrap(admin.page, dialog)
          await admin.page.keyboard.press('Escape')
          await expect(dialog).toBeHidden()
          await expect(trigger).toBeFocused()
        }
        await admin.page.keyboard.press('Escape')
        await expect(profile).toBeHidden()
        await expect(opener).toBeFocused()
        assert.deepEqual(admin.runtimeErrors, [])
      } finally {
        await admin.context.close()
      }
    },
  )

  test(
    'browser initial payment, lost committed renewal and receipt upload operate on PostgreSQL',
    { timeout: 90_000 },
    async () => {
      await db.authRateBucket.deleteMany() // disposable DB only
      const admin = await workspace()
      try {
        await admin.login('http-test-admin')
        await admin.page.getByRole('button', { name: 'Клиенты и дети', exact: true }).click()
        await admin.page.getByRole('button', { name: 'Добавить клиента', exact: true }).click()
        const create = admin.page.getByRole('dialog', { name: 'Новый клиент', exact: true })
        await create.getByLabel('Имя ребёнка', { exact: true }).fill('Browser finance pupil')
        await create.getByLabel('Имя родителя', { exact: true }).fill('Fictional parent')
        await create.getByLabel('Телефон', { exact: true }).fill('79990000000')
        await create.getByLabel('Филиал клиента', { exact: true }).selectOption(branch)
        await create.getByLabel('Секция', { exact: true }).selectOption('плавание')
        await create.getByLabel('Занятий в неделю', { exact: true }).selectOption('1')
        await create.getByPlaceholder('Введите сумму в рублях').fill('5500.01')
        const creationKeys: string[] = [],
          paymentKeys: string[] = []
        await admin.page.route('**/api/crm', async (route) => {
          const input = route.request().postDataJSON()
          if (!['createClient', 'recordPayment'].includes(input.action)) return route.continue()
          const keys = input.action === 'createClient' ? creationKeys : paymentKeys
          keys.push(input.payload.requestId)
          const response = await route.fetch()
          assert.equal(response.status(), 200)
          if (keys.length === 1)
            await route.fulfill({
              status: 408,
              contentType: 'application/json',
              body: JSON.stringify({ status: 'error', message: 'Fictional lost committed reply' }),
            })
          else await route.fulfill({ response })
        })
        await create.getByRole('button', { name: 'Создать профиль клиента', exact: true }).click()
        await create.getByRole('button', { name: 'Повторить тот же запрос', exact: true }).click()
        await expect(create).toBeHidden()
        assert.equal(creationKeys[0], creationKeys[1])
        const client = await db.client.findFirstOrThrow({ where: { childName: 'Browser finance pupil' } })
        assert.equal(client.remainingLessons, 4)
        assert.equal(client.paymentBalanceMinor, BigInt(1))
        await admin.page.getByRole('row').filter({ hasText: 'Browser finance pupil' }).click()
        let profile = admin.page.getByRole('dialog', { name: 'Browser finance pupil', exact: true })
        await profile.getByRole('button', { name: 'Продлить абонемент', exact: true }).click()
        const renewal = admin.page.getByRole('dialog', { name: 'Продление абонемента', exact: true })
        await renewal.getByLabel('Сумма нового платежа', { exact: true }).fill('5499.99')
        await renewal.getByRole('button', { name: 'Сохранить платёж', exact: true }).click()
        await expect(renewal).toBeHidden() // actual history confirms the lost reply, no second credit
        assert.equal(paymentKeys.length, 1)
        assert.equal((await db.client.findUniqueOrThrow({ where: { id: client.id } })).remainingLessons, 8)
        assert.equal(await db.payment.count({ where: { clientId: client.id } }), 2)
        const sharpModule = await import('sharp')
        const png = await sharpModule
          .default({ create: { width: 2, height: 2, channels: 3, background: '#00bbaa' } })
          .png()
          .toBuffer()
        const keys: string[] = []
        await admin.page.route('**/api/receipts/*', async (route) => {
          if (route.request().method() !== 'POST') return route.continue()
          keys.push(route.request().postDataJSON().requestId)
          const response = await route.fetch()
          assert.equal(response.status(), 200)
          if (keys.length === 1)
            await route.fulfill({
              status: 408,
              contentType: 'application/json',
              body: JSON.stringify({ status: 'error', message: 'Fictional lost receipt reply' }),
            })
          else await route.fulfill({ response })
        })
        profile = admin.page.getByRole('dialog', { name: 'Browser finance pupil', exact: true })
        const panel = profile.getByRole('region', { name: 'Квитанция клиента' })
        await panel
          .getByLabel('Файл квитанции', { exact: true })
          .setInputFiles({ name: 'Browser receipt.png', mimeType: 'image/png', buffer: png })
        await panel.getByRole('button', { name: 'Загрузить квитанцию', exact: true }).click()
        await panel.getByRole('button', { name: 'Повторить загрузку', exact: true }).click()
        await expect(panel.getByRole('link', { name: 'Скачать текущую квитанцию', exact: true })).toBeVisible()
        assert.equal(keys[0], keys[1])
        assert.equal(await db.document.count({ where: { clientId: client.id } }), 1)
        const download = await admin.context.request.get(origin + '/api/receipts/' + client.id)
        assert.equal(download.status(), 200)
        assert.ok((await download.body()).equals(png))
        assert.equal((await db.client.findUniqueOrThrow({ where: { id: client.id } })).remainingLessons, 8)
        assert.deepEqual(admin.runtimeErrors, [])
      } finally {
        await admin.context.close()
      }
    },
  )
}
