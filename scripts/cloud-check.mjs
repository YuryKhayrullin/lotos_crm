import { validateEnvironment, validateCloudMigration } from './lib/environment.mjs'
import { loadCloudEnvironment } from './lib/cloud-environment.mjs'
import { cloudDatabaseProvider } from './lib/cloud-database.mjs'
try {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== 'local-env')) throw Error('Invalid preflight arguments')
  const values = args[0] === 'local-env' ? loadCloudEnvironment().values : process.env
  if (values.DEPLOY_TARGET !== 'vercel') throw Error('Explicit Vercel staging required')
  const summary = validateEnvironment(values, 'staging')
  if (args[0] === 'local-env') validateCloudMigration(values)
  console.log(
    JSON.stringify({
      environment: summary.environment,
      deployment: 'vercel',
      databaseProvider: cloudDatabaseProvider(values),
      isolatedDatabase: true,
      receiptsEnabled: values.DOCUMENT_STORAGE !== 'disabled',
      privateStorageConfigured: values.DOCUMENT_STORAGE === 'vercel-blob',
      liveResourcesVerified: false,
    }),
  )
} catch {
  console.error(
    'Cloud preflight failed: check dedicated staging, exact TLS endpoints, private storage and private env permissions. No credentials logged.',
  )
  process.exitCode = 1
}
