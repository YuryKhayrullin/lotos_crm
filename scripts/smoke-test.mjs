const requiredNames = [
  'SMOKE_BASE_URL',
  'SMOKE_ADMIN_USERNAME',
  'SMOKE_ADMIN_PASSWORD',
  'SMOKE_COACH_USERNAME',
  'SMOKE_COACH_PASSWORD',
]

const missing = requiredNames.filter((name) => !process.env[name])
if (missing.length) {
  console.error(`Не заданы переменные smoke-test: ${missing.join(', ')}`)
  process.exit(1)
}

const baseUrl = new URL(process.env.SMOKE_BASE_URL)
if (baseUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(baseUrl.hostname)) {
  console.error('SMOKE_BASE_URL должен использовать HTTPS; исключение разрешено только для localhost')
  process.exit(1)
}

const origin = baseUrl.origin
const endpoint = (path) => new URL(path, baseUrl).toString()

async function send(path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(endpoint(path), {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: 'application/json',
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let data = null
  try {
    data = await response.json()
  } catch {
    // The assertion below reports the route and status without exposing a body.
  }
  return { response, data }
}

function assertStatus(result, expected, label) {
  if (result.response.status !== expected) {
    const code = result.data && typeof result.data.code === 'string' ? ` (${result.data.code})` : ''
    throw new Error(`${label}: ожидался HTTP ${expected}, получен ${result.response.status}${code}`)
  }
}

function sessionCookie(response) {
  const header = response.headers.get('set-cookie') || ''
  const pair = header.split(';', 1)[0]
  if (!pair.includes('=')) throw new Error('В ответе входа нет session cookie')
  return pair
}

async function login(role, username, password) {
  const result = await send('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  })
  assertStatus(result, 200, `Вход ${role}`)
  if (result.data?.user?.role !== role) throw new Error(`Вход ${role}: сервер вернул другую роль`)
  return sessionCookie(result.response)
}

async function session(role, cookie) {
  const result = await send('/api/auth/session', { cookie })
  assertStatus(result, 200, `Сессия ${role}`)
  if (!result.data?.authenticated || result.data?.user?.role !== role) {
    throw new Error(`Сессия ${role} не подтверждена`)
  }
}

async function crm(cookie, action, payload = {}) {
  return send('/api/crm', { method: 'POST', cookie, body: { action, payload } })
}

async function logout(role, cookie) {
  const result = await send('/api/auth/logout', { method: 'POST', cookie, body: {} })
  assertStatus(result, 200, `Выход ${role}`)
}

async function verifyDisabledCoach() {
  const username = process.env.SMOKE_DISABLED_COACH_USERNAME
  const password = process.env.SMOKE_DISABLED_COACH_PASSWORD
  if (!username && !password) return
  if (!username || !password) throw new Error('Для отключённого тренера нужны обе SMOKE_DISABLED_COACH_* переменные')
  const result = await send('/api/auth/login', { method: 'POST', body: { username, password } })
  assertStatus(result, 401, 'Вход отключённого тренера')
  if (result.data?.code !== 'UNAUTHORIZED') throw new Error('Отключённый тренер должен получать код UNAUTHORIZED')
}

async function main() {
  const adminCookie = await login('admin', process.env.SMOKE_ADMIN_USERNAME, process.env.SMOKE_ADMIN_PASSWORD)
  await session('admin', adminCookie)
  assertStatus(await crm(adminCookie, 'getDashboardSummary'), 200, 'Дашборд администратора')
  assertStatus(await crm(adminCookie, 'getFinanceSummary'), 200, 'Финансы администратора')

  if (process.env.SMOKE_REQUIRE_LEDGER_CLEAN === '1') {
    const audit = await crm(adminCookie, 'auditLessonLedger')
    assertStatus(audit, 200, 'Сверка журнала занятий')
    const discrepancies = Array.isArray(audit.data?.discrepancies) ? audit.data.discrepancies.length : null
    if (discrepancies === null) throw new Error('Сверка журнала вернула неожиданный ответ')
    if (discrepancies > 0) throw new Error(`Сверка журнала: найдено расхождений: ${discrepancies}`)
  }

  const coachCookie = await login('coach', process.env.SMOKE_COACH_USERNAME, process.env.SMOKE_COACH_PASSWORD)
  await session('coach', coachCookie)
  assertStatus(await crm(coachCookie, 'getDashboardSummary'), 200, 'Дашборд тренера')
  const forbidden = await crm(coachCookie, 'getFinanceSummary')
  assertStatus(forbidden, 403, 'Запрет финансов для тренера')
  if (forbidden.data?.code !== 'FORBIDDEN') throw new Error('Недостаток прав должен возвращать код FORBIDDEN')

  await verifyDisabledCoach()
  await logout('coach', coachCookie)
  await logout('admin', adminCookie)
  console.log('✓ Smoke-test admin/coach пройден; записей в CRM не выполнялось')
}

main().catch((error) => {
  console.error(`✗ Smoke-test: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`)
  process.exitCode = 1
})
