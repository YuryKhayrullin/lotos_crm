import { X509Certificate } from 'node:crypto'

function requireSafe(condition, field) {
  if (!condition) throw Error('Unsafe cloud database setting: ' + field)
}

export function cloudDatabaseProvider(values) {
  const provider = values.CLOUD_DATABASE_PROVIDER || 'neon'
  requireSafe(['neon', 'supabase'].includes(provider), 'provider')
  return provider
}

// One base64 PEM environment value; no arbitrary filesystem path. Node checks
// both the certificate authority and hostname when establishing each socket.
export function cloudDatabaseCertificate(values) {
  const encoded = values.CLOUD_DATABASE_CA_BASE64 || ''
  requireSafe(encoded.length > 0 && encoded.length <= 32_768 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), 'CA encoding')
  const bytes = Buffer.from(encoded, 'base64')
  requireSafe(bytes.toString('base64') === encoded, 'canonical CA encoding')
  const pem = bytes.toString('utf8')
  requireSafe(
    /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\r?\n?$/.test(pem),
    'CA PEM',
  )
  try {
    const certificate = new X509Certificate(pem)
    requireSafe(
      certificate.ca && Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) > Date.now(),
      'valid CA certificate',
    )
  } catch {
    throw Error('Unsafe cloud database setting: valid CA certificate')
  }
  return pem
}

export function cloudDatabaseIdentity(values) {
  const provider = cloudDatabaseProvider(values)
  if (provider === 'neon') {
    requireSafe(/^[a-z0-9-]+-pooler\.[a-z0-9.-]+\.neon\.tech$/.test(values.CLOUD_DATABASE_HOST || ''), 'Neon endpoint')
    requireSafe(!values.CLOUD_SUPABASE_PROJECT_REF && !values.CLOUD_DATABASE_CA_BASE64, 'unambiguous Neon profile')
    return { provider, database: 'lotos_crm_staging', username: 'lotos_runtime', role: 'lotos_runtime' }
  }
  const ref = values.CLOUD_SUPABASE_PROJECT_REF || ''
  requireSafe(/^[a-z]{20}$/.test(ref), 'Supabase project reference')
  requireSafe(values.CLOUD_DATABASE_ISOLATED === 'true', 'dedicated staging project acknowledgement')
  requireSafe(
    /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(values.CLOUD_DATABASE_HOST || ''),
    'Supabase session endpoint',
  )
  cloudDatabaseCertificate(values)
  return { provider, database: 'postgres', username: 'lotos_runtime.' + ref, role: 'lotos_runtime' }
}

export function cloudMigrationUsername(values, runtime, direct) {
  const identity = cloudDatabaseIdentity(values)
  if (identity.provider === 'neon') {
    requireSafe(direct.hostname === runtime.hostname.replace('-pooler.', '.'), 'matching Neon project')
    return 'lotos_migrator'
  }
  const ref = values.CLOUD_SUPABASE_PROJECT_REF
  // Session mode preserves migration advisory locks and supports IPv4.
  requireSafe(
    direct.hostname === runtime.hostname || direct.hostname === 'db.' + ref + '.supabase.co',
    'matching Supabase project',
  )
  return direct.hostname === runtime.hostname ? 'lotos_migrator.' + ref : 'lotos_migrator'
}

export function runtimeDatabaseOptions(values) {
  if (values.DEPLOY_TARGET !== 'vercel' || cloudDatabaseProvider(values) !== 'supabase')
    return { connectionString: values.DATABASE_URL }
  cloudDatabaseIdentity(values)
  const url = new URL(values.DATABASE_URL)
  // pg URL SSL parameters would replace config.ssl, dropping the explicit CA.
  // Validation still requires exactly sslmode=verify-full on the input.
  requireSafe(url.searchParams.size === 1 && url.searchParams.get('sslmode') === 'verify-full', 'runtime TLS mode')
  url.search = ''
  return { connectionString: url.toString(), ssl: { ca: cloudDatabaseCertificate(values), rejectUnauthorized: true } }
}
