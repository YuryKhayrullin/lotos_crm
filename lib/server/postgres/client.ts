import 'server-only'
import { createHash } from 'node:crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { attachDatabasePool } from '@vercel/functions'
import { PrismaClient } from '../../../.generated/prisma/client'
import { validateEnvironment } from '../../../scripts/lib/environment.mjs'
import { runtimeDatabaseOptions } from '../../../scripts/lib/cloud-database.mjs'

// Explicit factory, not an import-time connection or fallback to legacy env.
// Entrypoints are responsible for server-only boundaries and one reused client.
export function createPostgresClient(values: NodeJS.ProcessEnv) {
  validateEnvironment(values, values.APP_ENV)
  const cloud = values.DEPLOY_TARGET === 'vercel'
  const pool = new Pool({
    ...runtimeDatabaseOptions(values),
    // One reusable connection per serverless process; the provider multiplexes
    // instances. Local/self-hosted retains its existing five-connection pool.
    max: cloud ? 1 : 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: cloud ? 5_000 : 30_000,
    // PgBouncer may reject arbitrary startup GUCs. In cloud the role's
    // statement_timeout is configured by the operator and verified preflight.
    statement_timeout: cloud ? undefined : 10_000,
    query_timeout: cloud ? 10_000 : undefined,
  })
  if (cloud && values.VERCEL === '1') attachDatabasePool(pool)
  const adapter = new PrismaPg(pool, { disposeExternalPool: true })
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
    .update(
      JSON.stringify([
        values.APP_ENV,
        values.DATABASE_URL,
        values.CLOUD_DATABASE_PROVIDER,
        values.CLOUD_DATABASE_CA_BASE64,
      ]),
    )
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
