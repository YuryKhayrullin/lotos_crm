const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

test('Node runtime range includes the observed Vercel patch but excludes older and other major versions', () => {
  const root = path.resolve(__dirname, '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const semver = require('semver')
  assert.equal(pkg.engines.node, lock.packages[''].engines.node)
  for (const version of ['22.23.2', '22.23.3']) assert.equal(semver.satisfies(version, pkg.engines.node), true)
  for (const version of ['22.23.1', '20.19.0', '24.0.0'])
    assert.equal(semver.satisfies(version, pkg.engines.node), false)
})

test('Prisma merge dependency safely handles the published recursive-graph regression', async () => {
  const { deepmerge } = await import('deepmerge-ts')
  const left = {},
    right = {}
  left.self = left
  right.self = right
  assert.doesNotThrow(() => deepmerge(left, right))
})

test('Prisma merge keeps ordinary configuration values and does not mutate the inputs', async () => {
  const { deepmerge } = await import('deepmerge-ts')
  const left = { migrations: { path: 'prisma/migrations' }, datasource: { url: 'fixture-only' }, flags: [1] }
  const right = { migrations: { seed: 'fixture-only' }, flags: [2] }
  assert.deepEqual(deepmerge(left, right), {
    migrations: { path: 'prisma/migrations', seed: 'fixture-only' },
    datasource: { url: 'fixture-only' },
    flags: [1, 2],
  })
  assert.deepEqual(left, { migrations: { path: 'prisma/migrations' }, datasource: { url: 'fixture-only' }, flags: [1] })
})

test('Prisma actually loads both guarded config files after the security override, without a database connection', () => {
  const root = path.resolve(__dirname, '..')
  for (const configFile of ['prisma.config.ts', 'prisma.deploy.config.ts']) {
    const env = { ...process.env }
    for (const name of Object.keys(env)) {
      if (
        /^(APP_|DATABASE_|DIRECT_URL|POSTGRES_|PG|BETTER_AUTH_|GAS_|SESSION_SECRET|RUNTIME_|MIGRATOR_|BACKUP_)/.test(
          name,
        )
      )
        delete env[name]
    }
    Object.assign(env, {
      APP_ENV: 'staging',
      CRM_BACKEND: 'postgres',
      APP_URL: 'https://staging.fictional.test',
      DATABASE_URL: `postgresql://lotos_runtime:${'2'.repeat(64)}@db:5432/lotos_crm_staging`,
      DIRECT_URL: `postgresql://lotos_migrator:${'3'.repeat(64)}@db:5432/lotos_crm_staging`,
      BETTER_AUTH_SECRET: '4'.repeat(64),
    })
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { loadConfigFromFile } from '@prisma/config';
      process.argv[2] = 'generate';
      const loaded = await loadConfigFromFile({configFile: ${JSON.stringify(configFile)}, configRoot: ${JSON.stringify(root)}});
      assert.equal(loaded.error, undefined);
      assert.ok(loaded.config.schema.endsWith('/prisma/schema.prisma'));
      assert.ok(loaded.config.migrations.path.endsWith('/prisma/migrations'));
      ${configFile === 'prisma.deploy.config.ts' ? 'assert.equal(loaded.config.datasource.url, process.env.DIRECT_URL);' : ''}
    `,
      ],
      { cwd: root, env, encoding: 'utf8', timeout: 15_000 },
    )
    assert.equal(child.status, 0, 'Guarded config loader succeeds (no credentials logged)')
  }
})
