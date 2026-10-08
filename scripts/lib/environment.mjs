const files = Object.freeze({
  local: '.env.db.local',
  test: '.env.db.test.local',
  staging: '.env.staging.local',
  production: '.env.production.local',
})

export function environmentFile(environment) {
  if (!Object.hasOwn(files, environment))
    throw new Error('Choose an explicit APP_ENV: local, test, staging or production')
  return files[environment]
}

export function parseEnv(source) {
  const values = {}
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!match || Object.hasOwn(values, match[1]))
      throw new Error('Invalid or duplicate env assignment at line ' + (index + 1))
    let value = match[2].trim()
    if (/^['"]/.test(value)) {
      if (value.at(-1) !== value[0]) throw new Error('Invalid quoting at line ' + (index + 1))
      value = value.slice(1, -1)
    }
    if (/[\r\n\0$`]/.test(value)) throw new Error('Env expansion is forbidden at line ' + (index + 1))
    values[match[1]] = value
  }
  return values
}

function requireValue(condition, field) {
  if (!condition) throw new Error('Unsafe or missing environment setting: ' + field)
}

export function validateEnvironment(values, expected) {
  environmentFile(expected)
  requireValue(values.APP_ENV === expected, 'APP_ENV')
  requireValue(values.CRM_BACKEND === 'postgres', 'CRM_BACKEND')
  let database, app
  try {
    database = new URL(values.DATABASE_URL)
    app = new URL(values.APP_URL)
  } catch {
    throw new Error('Invalid DATABASE_URL or APP_URL')
  }
  requireValue(database.protocol === 'postgresql:', 'DATABASE_URL protocol')
  requireValue(
    !database.hash && [...database.searchParams].every(([key, value]) => key === 'schema' && value === 'public'),
    'DATABASE_URL options',
  )
  requireValue(!app.username && !app.password && !app.search && !app.hash && app.pathname === '/', 'APP_URL')
  const secret = values.BETTER_AUTH_SECRET || ''
  requireValue(/^[a-f0-9]{64}$/.test(secret), 'BETTER_AUTH_SECRET')
  const password = decodeURIComponent(database.password)
  requireValue(/^[a-f0-9]{64}$/.test(password) && password !== secret, 'DATABASE_URL password')
  const name = database.pathname.slice(1)
  if (expected === 'local' || expected === 'test') {
    const suffix = expected === 'local' ? 'local' : 'test'
    requireValue(database.hostname === '127.0.0.1', 'DATABASE_URL host')
    requireValue(database.port === (expected === 'local' ? '55432' : '55433'), 'DATABASE_URL port')
    requireValue(name === 'lotos_crm_' + suffix, 'DATABASE_URL database')
    requireValue(database.username === 'lotos_' + suffix, 'DATABASE_URL role')
    requireValue(
      values.POSTGRES_DB === name &&
        values.POSTGRES_USER === database.username &&
        values.POSTGRES_PASSWORD === password,
      'POSTGRES credentials',
    )
    requireValue(app.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(app.hostname), 'APP_URL local origin')
  } else {
    requireValue(database.hostname === 'db' && database.port === '5432', 'DATABASE_URL private service')
    requireValue(
      name === 'lotos_crm_' + expected && database.username === 'lotos_runtime',
      'DATABASE_URL runtime identity',
    )
    requireValue(
      app.protocol === 'https:' &&
        !['localhost', '127.0.0.1'].includes(app.hostname) &&
        !app.hostname.endsWith('.example'),
      'APP_URL HTTPS origin',
    )
  }
  return { environment: expected, database: name, host: database.hostname, port: database.port }
}
