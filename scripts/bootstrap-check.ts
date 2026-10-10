import { checkBootstrapLibpq } from './lib/bootstrap-libpq'
import { bootstrapFailureMessage } from './lib/bootstrap-feedback.mjs'

try {
  if (process.argv.length !== 2 || process.env.BOOTSTRAP_CLOUD_ADMIN !== 'read-only-check')
    throw Error('Read-only guard required')
  const result = checkBootstrapLibpq(process.env)
  console.log(JSON.stringify({ transport: 'libpq', ...result, accountCreated: false }))
} catch (error) {
  console.error(bootstrapFailureMessage(error, { phase: 'preflight', step: undefined, elapsedMs: undefined }))
  process.exitCode = 1
}
