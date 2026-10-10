import { cloudDatabaseIdentity, cloudMigrationUsername } from './cloud-database.mjs'

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
  const target = values.DEPLOY_TARGET || 'self-hosted'
  requireValue(['self-hosted', 'vercel'].includes(target), 'DEPLOY_TARGET')
  requireValue(target !== 'vercel' || expected === 'staging', 'cloud staging isolation')
  let database, app
  try {
    database = new URL(values.DATABASE_URL)
    app = new URL(values.APP_URL)
  } catch {
    throw new Error('Invalid DATABASE_URL or APP_URL')
  }
  requireValue(database.protocol === 'postgresql:', 'DATABASE_URL protocol')
  requireValue(
    !database.hash &&
      (target === 'vercel'
        ? database.searchParams.size === 1 && database.searchParams.get('sslmode') === 'verify-full'
        : [...database.searchParams].every(([key, value]) => key === 'schema' && value === 'public')),
    'DATABASE_URL options',
  )
  requireValue(!app.username && !app.password && !app.search && !app.hash && app.pathname === '/', 'APP_URL')
  const secret = values.BETTER_AUTH_SECRET || ''
  requireValue(/^[a-f0-9]{64}$/.test(secret), 'BETTER_AUTH_SECRET')
  const password = decodeURIComponent(database.password)
  requireValue(/^[a-f0-9]{64}$/.test(password) && password !== secret, 'DATABASE_URL password')
  const name = database.pathname.slice(1)
  if (expected === 'local' || expected === 'test') {
    requireValue(
      values.VERCEL !== '1' && (!values.DOCUMENT_STORAGE || values.DOCUMENT_STORAGE === 'filesystem'),
      'no cloud resources in Local/Test',
    )
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
    if (target === 'vercel') {
      const cloud = cloudDatabaseIdentity(values)
      requireValue(
        database.hostname === values.CLOUD_DATABASE_HOST &&
          (cloud.provider === 'supabase' ? ['5432', '6543'].includes(database.port) : database.port === '5432'),
        'cloud endpoint identity',
      )
      requireValue(
        ['vercel-blob', 'disabled'].includes(values.DOCUMENT_STORAGE) && !values.DOCUMENTS_DIR,
        'cloud storage profile',
      )
      if (values.DOCUMENT_STORAGE === 'vercel-blob')
        requireValue(/^store_[a-z0-9]{8,64}$/i.test(values.BLOB_STORE_ID || ''), 'BLOB_STORE_ID')
      else requireValue(!values.BLOB_STORE_ID && !values.BLOB_READ_WRITE_TOKEN, 'no Blob credentials when disabled')
      requireValue(
        values.TRUSTED_PROXY === 'vercel' && values.COACH_REGISTRATION_ENABLED === 'false',
        'cloud proxy/registration',
      )
      requireValue(values.VERCEL !== '1' || values.VERCEL_ENV === 'production', 'dedicated stable staging deployment')
      requireValue(!values.VERCEL_BLOB_API_URL && !values.NEXT_PUBLIC_VERCEL_BLOB_API_URL, 'no Blob endpoint overrides')
      requireValue(!values.DEBUG && !values.NEXT_PUBLIC_DEBUG, 'no verbose cloud credential logging')
      requireValue(
        !Object.keys(values).some((name) => /^NEXT_PUBLIC_.*(?:PASSWORD|SECRET|TOKEN|DATABASE|DIRECT_URL)/i.test(name)),
        'no public credentials',
      )
    } else {
      requireValue(values.VERCEL !== '1', 'explicit Vercel profile required')
      requireValue(!values.DOCUMENT_STORAGE || values.DOCUMENT_STORAGE === 'filesystem', 'filesystem profile')
      requireValue(database.hostname === 'db' && database.port === '5432', 'DATABASE_URL private service')
    }
    const identity = target === 'vercel' ? cloudDatabaseIdentity(values) : null
    requireValue(
      name === (identity?.database || 'lotos_crm_' + expected) &&
        database.username === (identity?.username || 'lotos_runtime'),
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

// Separate operator-only migration URL. No CLI caller may fall back to the
// application's runtime role or the owner of an unrelated cloud database.
export function validateCloudMigration(values) {
  requireValue(values.DEPLOY_TARGET === 'vercel', 'cloud migration profile')
  validateEnvironment(values, 'staging')
  let direct, runtime
  try {
    direct = new URL(values.DIRECT_URL || '')
    runtime = new URL(values.DATABASE_URL)
  } catch {
    throw new Error('Invalid cloud migration connection (no credentials logged)')
  }
  requireValue(
    direct.protocol === 'postgresql:' &&
      !direct.hash &&
      direct.port === '5432' &&
      direct.hostname === values.CLOUD_DATABASE_DIRECT_HOST &&
      direct.pathname === runtime.pathname &&
      direct.username === cloudMigrationUsername(values, runtime, direct) &&
      /^[a-f0-9]{64}$/.test(direct.password) &&
      direct.password !== runtime.password &&
      direct.password !== values.BETTER_AUTH_SECRET &&
      direct.searchParams.size === 1 &&
      direct.searchParams.get('sslmode') === 'verify-full',
    'separate TLS migration endpoint',
  )
  return direct
}
