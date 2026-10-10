import { spawnSync } from 'node:child_process'
import { loadCloudEnvironment, cloudChildEnvironment } from './lib/cloud-environment.mjs'
import { validateCloudMigration } from './lib/environment.mjs'
import { withCloudMigrationCertificate } from './lib/cloud-migration-tls.mjs'
import { runBoundedCommand } from './lib/bounded-command.mjs'
try {
  if (
    process.argv.length !== 3 ||
    !['status', 'migrate', 'storage-init', 'bootstrap', 'bootstrap-sql', 'bootstrap-check', 'verify'].includes(
      process.argv[2],
    )
  )
    throw Error('Explicit operator action required')
  const { root, values } = loadCloudEnvironment()
  const action = process.argv[2],
    env = cloudChildEnvironment(values)
  if (Number(process.versions.node.split('.')[0]) !== 22) throw Error('Node.js 22 required')
  let args
  if (action === 'migrate' || action === 'status') {
    validateCloudMigration(values)
    args = [
      'node_modules/prisma/build/index.js',
      'migrate',
      action === 'status' ? 'status' : 'deploy',
      '--config',
      'prisma.vercel.config.ts',
    ]
  } else {
    if (['bootstrap', 'bootstrap-sql'].includes(action) && (!process.stdin.isTTY || !process.stdout.isTTY))
      throw Error('Owner must enter credentials interactively')
    if (action === 'bootstrap') env.BOOTSTRAP_CLOUD_ADMIN = 'explicit-operator'
    if (action === 'bootstrap-sql') env.BOOTSTRAP_CLOUD_ADMIN = 'sql-editor'
    if (action === 'bootstrap-check') env.BOOTSTRAP_CLOUD_ADMIN = 'read-only-check'
    args = [
      '--conditions=react-server',
      '--import',
      'tsx',
      action === 'bootstrap'
        ? 'scripts/bootstrap-admin.ts'
        : action === 'bootstrap-sql'
          ? 'scripts/bootstrap-sql-editor.ts'
          : action === 'bootstrap-check'
            ? 'scripts/bootstrap-check.ts'
            : 'scripts/cloud-storage.ts',
      ...(['bootstrap', 'bootstrap-sql', 'bootstrap-check'].includes(action) ? [] : [action]),
    ]
  }
  const execute = (certificateEnv = {}) =>
    runBoundedCommand(process.execPath, args, {
      cwd: root,
      env: { ...env, ...certificateEnv },
      timeoutMs: action === 'status' ? 30000 : 180000,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
  const result =
    action === 'migrate' || action === 'status'
      ? await withCloudMigrationCertificate(values, execute)
      : ['bootstrap', 'bootstrap-sql'].includes(action)
        ? spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
        : await execute()
  if (result.timedOut || result.interrupted) {
    console.error(
      'Cloud command timed out or was cancelled; child processes stopped. Do not retry a migration before inspecting its history.',
    )
    process.exitCode = 2
  } else if (
    ['status', 'bootstrap', 'bootstrap-sql', 'bootstrap-check'].includes(action) &&
    !result.error &&
    result.status !== null
  ) {
    // Prisma status also returns 1 for pending migrations; keep its diagnostic.
    // Bootstrap already printed its safe cause; do not replace it with a generic error.
    process.exitCode = result.status
  } else if (result.error || result.status !== 0) throw Error('Operator command failed')
} catch {
  console.error('Cloud operator action failed. No credentials logged; Local/GAS/production are not fallback targets.')
  process.exitCode = 1
}
