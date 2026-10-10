import { defineConfig } from 'prisma/config'
import { validateCloudMigration } from './scripts/lib/environment.mjs'
import { prismaCloudMigrationUrl } from './scripts/lib/cloud-migration-tls.mjs'

// Never loaded by a normal build, Local CLI or application request.
const direct = validateCloudMigration(process.env)
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: prismaCloudMigrationUrl(process.env, direct) },
})
