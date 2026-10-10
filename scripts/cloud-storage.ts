import { createBlobStorage } from '../lib/server/postgres/blob-storage'
import { createPostgresClient } from '../lib/server/postgres/client'
import { validateEnvironment } from './lib/environment.mjs'
import { cloudDatabaseIdentity } from './lib/cloud-database.mjs'

async function main() {
  if (process.argv.length !== 3 || !['storage-init', 'verify'].includes(process.argv[2]))
    throw Error('Explicit cloud action required')
  validateEnvironment(process.env, 'staging')
  if (process.env.DEPLOY_TARGET !== 'vercel') throw Error('Only Vercel staging')
  const storage = process.env.DOCUMENT_STORAGE === 'disabled' ? null : createBlobStorage(process.env)
  if (process.argv[2] === 'storage-init') {
    if (!storage) throw Error('Receipts explicitly disabled; storage setup forbidden')
    await storage.setup() // Private health marker only; no accounts/documents.
    console.log('Private staging storage marker confirmed; no CRM accounts created')
    return
  }
  const identity = cloudDatabaseIdentity(process.env)
  const db = createPostgresClient(process.env)
  try {
    const roles = await db.$queryRaw<
      Array<{
        name: string
        role: string
        rolsuper: boolean
        rolcreatedb: boolean
        rolcreaterole: boolean
        rolbypassrls: boolean
        can_create: boolean
        statement_timeout: string
      }>
    >`
      SELECT current_database() AS name, current_user AS role, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
        has_schema_privilege(current_user,'public','CREATE') AS can_create,
        current_setting('statement_timeout') AS statement_timeout
      FROM pg_roles WHERE rolname=current_user`
    const role = roles[0]
    if (
      !role ||
      role.name !== identity.database ||
      role.role !== identity.role ||
      role.rolsuper ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolbypassrls ||
      role.can_create ||
      role.statement_timeout !== '10s'
    )
      throw Error('Unsafe runtime role')
    const unsafe = await db.$queryRaw<Array<{ unsafe: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tableowner=current_user)
        OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user))
        AS unsafe`
    if (unsafe[0]?.unsafe !== false) throw Error('Runtime owns tables or inherits roles')
    const migrations = await db.$queryRaw<Array<{ ready: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM _prisma_migrations WHERE migration_name='202610080009_complete_recovery' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS ready`
    if (!migrations[0]?.ready || (storage && !(await storage.ready()))) throw Error('Schema/private storage not ready')
    console.log(
      storage
        ? 'Dedicated staging SQL identity, least-privilege flags, migrations and private storage verified'
        : 'Dedicated staging SQL identity, least-privilege flags and migrations verified; receipts disabled',
    )
  } finally {
    await db.$disconnect()
  }
}
main().catch(() => {
  console.error('Cloud verification/storage setup failed; no credentials or internal errors logged')
  process.exitCode = 1
})
