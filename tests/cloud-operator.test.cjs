const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

test('cloud preflight rejects production/missing configuration without connecting or printing secrets', () => {
  const env = {
    ...process.env,
    APP_ENV: 'production',
    DEPLOY_TARGET: 'vercel',
    CRM_BACKEND: 'postgres',
    DATABASE_URL: 'not-a-connection',
  }
  const child = spawnSync(process.execPath, ['scripts/cloud-check.mjs'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(child.status, 1)
  assert.doesNotMatch(child.stdout + child.stderr, /not-a-connection|postgresql:\/\//)
})
test('cloud operator cannot accept password arguments or silently invoke Local bootstrap', () => {
  const child = spawnSync(process.execPath, ['scripts/cloud-operator.mjs', 'bootstrap', 'never-a-real-password'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(child.status, 1)
  assert.doesNotMatch(child.stdout + child.stderr, /never-a-real-password/)
  const source = fs.readFileSync(path.join(root, 'scripts/cloud-operator.mjs'), 'utf8')
  assert.match(source, /process\.stdin\.isTTY/)
  assert.match(source, /BOOTSTRAP_CLOUD_ADMIN/)
  assert.doesNotMatch(source, /bootstrap-local-generated/)
})
test('Vercel staging source excludes credentials/workbook and automatic Git production deploys', () => {
  const ignore = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8').split('\n')
  for (const name of ['.env*', '**/.env*', '**/*.xlsx', '.private', '.artifacts', '.migration-baseline'])
    assert.ok(ignore.includes(name))
  const config = JSON.parse(fs.readFileSync(path.join(root, 'infra/vercel.staging.json'), 'utf8'))
  assert.equal(config.git.deploymentEnabled, false)
  assert.equal(config.buildCommand, 'npm run cloud:build')
  assert.equal(config.env, undefined)
})

test('cloud child environment cannot inherit IDE debug, engine or TLS overrides', async () => {
  const { cloudChildEnvironment } = await import('../scripts/lib/cloud-environment.mjs')
  const names = [
    'DEBUG',
    'NEXT_PUBLIC_DEBUG',
    'RUST_LOG',
    'PRISMA_SCHEMA_ENGINE_BINARY',
    'NODE_OPTIONS',
    'OPENSSL_CONF',
    'PGOPTIONS',
  ]
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  try {
    for (const name of names) process.env[name] = 'fictional-unsafe-override'
    const env = cloudChildEnvironment({ APP_ENV: 'staging' })
    for (const name of names) assert.equal(env[name], undefined, name)
    assert.equal(env.APP_ENV, 'staging')
    assert.equal(env.NODE_ENV, 'production')
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
})

test('bounded cloud commands exit normally and stop on timeout without automatic retry', async () => {
  const { runBoundedCommand } = await import('../scripts/lib/bounded-command.mjs')
  const normal = await runBoundedCommand(process.execPath, ['-e', 'process.exit(0)'], {
    cwd: root,
    env: process.env,
    timeoutMs: 3000,
    stdio: 'ignore',
  })
  assert.equal(normal.status, 0)
  assert.equal(normal.timedOut, false)
  const timeout = await runBoundedCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    cwd: root,
    env: process.env,
    timeoutMs: 100,
    killAfterMs: 100,
    stdio: 'ignore',
  })
  assert.equal(timeout.timedOut, true)
  assert.notEqual(timeout.status, 0)
  assert.equal(timeout.interrupted, false)
})
