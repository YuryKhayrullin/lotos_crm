import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv, validateEnvironment } from './environment.mjs'

export function loadCloudEnvironment() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const filename = path.join(root, '.env.vercel.staging.local')
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid?.())
    throw Error('Private owned cloud env required')
  const values = parseEnv(fs.readFileSync(filename, 'utf8'))
  validateEnvironment(values, 'staging')
  if (values.DEPLOY_TARGET !== 'vercel') throw Error('Explicit Vercel staging required')
  return { root, values }
}

export function cloudChildEnvironment(values) {
  const inherited = { ...process.env }
  // Operator commands must not inherit debugging/engine/TLS overrides from
  // the IDE shell. The validated profile and owned CA are the only authority.
  for (const name of [
    'DEBUG',
    'NEXT_PUBLIC_DEBUG',
    'RUST_LOG',
    'RUST_BACKTRACE',
    'NODE_OPTIONS',
    'OPENSSL_CONF',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ])
    delete inherited[name]
  for (const name of Object.keys(inherited)) {
    if (
      /^(PRISMA_|APP_|CRM_|GAS_|DATABASE_|DIRECT_URL|POSTGRES_|PG|BETTER_AUTH_|SESSION_|CLOUD_|BLOB_|VERCEL|NEXT_PUBLIC_VERCEL|DEPLOY_|DOCUMENT|TRUSTED_PROXY|COACH_REGISTRATION)/.test(
        name,
      )
    )
      delete inherited[name]
  }
  return {
    ...inherited,
    ...values,
    NODE_ENV: 'production',
    GAS_WEBAPP_URL: '',
    GAS_HMAC_SECRET: '',
    SESSION_SECRET: '',
  }
}
