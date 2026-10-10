import { defineConfig } from 'prisma/config'
import { validateEnvironment } from './scripts/lib/environment.mjs'

// No dotenv import: callers must explicitly load the isolated environment.
const schemaOnly = ['generate', 'validate', 'format'].includes(process.argv[2] || '')
if (!schemaOnly) {
  const environment = process.env.APP_ENV
  if (!['local', 'test'].includes(environment || '')) {
    throw new Error('Stage 3 migration CLI is restricted to explicit local/test environments')
  }
  validateEnvironment(process.env, environment)
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // A schema-only build needs no credentials and does not connect to a DB.
  datasource: schemaOnly ? undefined : { url: process.env.DATABASE_URL! },
})
