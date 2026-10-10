const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { existsSync, statSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const filename = path.join(root, '.artifacts/local-admin-access.json')
function fileState() {
  if (!existsSync(filename)) return null
  const stat = statSync(filename)
  return { size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs }
}
function refused(args, environment) {
  const before = fileState()
  const result = spawnSync(
    process.execPath,
    ['--conditions=react-server', '--import', 'tsx', 'scripts/bootstrap-local-generated.ts', ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, APP_ENV: environment }, timeout: 20000 },
  )
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Local bootstrap не подтверждён/)
  assert.deepEqual(fileState(), before)
}
test('generated Local bootstrap rejects staging/production before credentials or SQL', () => {
  refused([], 'production')
  refused([], 'staging')
})
test('generated Local bootstrap rejects arguments including externally supplied passwords', () => {
  refused(['--password', 'fictional-never-used'], 'local')
})
