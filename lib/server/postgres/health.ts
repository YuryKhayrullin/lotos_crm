import 'server-only'
import { promises as fs } from 'node:fs'
import type { PrismaClient } from '../../../.generated/prisma/client'
import { documentRoot } from './documents'
import { createBlobStorage } from './blob-storage'
import { receiptUploadLimit } from '../../receipt-limits'
import { validateEnvironment } from '../../../scripts/lib/environment.mjs'

export async function postgresReadiness(db: PrismaClient, values: NodeJS.ProcessEnv) {
  try {
    validateEnvironment(values, values.APP_ENV)
    // One generic readiness bit, never a list of migrations/paths/credentials.
    const rows = await db.$queryRaw<Array<{ ready: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM _prisma_migrations
        WHERE migration_name='202610080009_complete_recovery' AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS ready`
    if (!rows[0]?.ready) return false
    if (receiptUploadLimit(values) === 0) return true
    if (values.DEPLOY_TARGET === 'vercel') return await createBlobStorage(values).ready()
    const root = documentRoot(values)
    const stat = await fs.lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || (await fs.realpath(root)) !== root)
      return false
    await fs.access(root, fs.constants.R_OK | fs.constants.W_OK)
    const disk = await fs.statfs(root)
    return Number(disk.bavail) * Number(disk.bsize) >= 64 * 1024 * 1024
  } catch {
    return false
  }
}
