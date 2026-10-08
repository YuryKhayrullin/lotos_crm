import 'server-only'
import { createHash } from 'node:crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../../.generated/prisma/client'
import { validateEnvironment } from '../../../scripts/lib/environment.mjs'

// Explicit factory, not an import-time connection or fallback to legacy env.
// Entrypoints are responsible for server-only boundaries and one reused client.
export function createPostgresClient(values: NodeJS.ProcessEnv) {
  validateEnvironment(values, values.APP_ENV)
  const adapter = new PrismaPg({
    connectionString: values.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
  })
  return new PrismaClient({
    adapter,
    log: [],
    transactionOptions: { maxWait: 5_000, timeout: 10_000 },
  })
}

const processCache = globalThis as typeof globalThis & {
  lotosPostgres?: { fingerprint: string; client: PrismaClient }
}

// Lazy process-wide reuse, including Next development hot reload. No database
// is contacted during module import/build; changed credentials fail closed.
export function getPostgresClient(values: NodeJS.ProcessEnv = process.env) {
  validateEnvironment(values, values.APP_ENV)
  const fingerprint = createHash('sha256')
    .update(values.APP_ENV! + ':' + values.DATABASE_URL!)
    .digest('hex')
  if (processCache.lotosPostgres) {
    if (processCache.lotosPostgres.fingerprint !== fingerprint)
      throw new Error('PostgreSQL configuration changed; restart the application')
    return processCache.lotosPostgres.client
  }
  const client = createPostgresClient(values)
  processCache.lotosPostgres = { fingerprint, client }
  return client
}
