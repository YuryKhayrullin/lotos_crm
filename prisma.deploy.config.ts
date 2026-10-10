import { defineConfig } from 'prisma/config'
import { validateEnvironment } from './scripts/lib/environment.mjs'

const environment = process.env.APP_ENV
if (!['staging', 'production'].includes(environment || '')) throw Error('Explicit staging/production required')
validateEnvironment(process.env, environment)
let direct: URL, runtime: URL
try {
  direct = new URL(process.env.DIRECT_URL || '')
  runtime = new URL(process.env.DATABASE_URL!)
} catch {
  // URL TypeError.input can contain a password; never let CLI print it.
  throw Error('Invalid private migration connection; no credentials logged')
}
if (
  direct.protocol !== 'postgresql:' ||
  direct.hostname !== 'db' ||
  direct.port !== '5432' ||
  direct.pathname !== runtime.pathname ||
  direct.username !== 'lotos_migrator' ||
  direct.hash ||
  !/^[a-f0-9]{64}$/.test(direct.password) ||
  direct.password === runtime.password ||
  direct.search
)
  throw Error('Separate private migration role required')
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: direct.toString() },
})
