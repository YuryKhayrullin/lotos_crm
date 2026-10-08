import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { parseEnv, validateEnvironment } from './lib/environment.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dockerEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('DOCKER_') && !key.startsWith('PG')),
)
dockerEnvironment.DOCKER_HOST = 'unix:///var/run/docker.sock'
function command(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: dockerEnvironment,
    ...options,
  })
  if (result.error || result.status !== 0) throw Error('Local backup command failed')
  return result.stdout || ''
}
try {
  if (process.argv.length !== 2) throw Error('No backup target overrides are allowed')
  const values = parseEnv(fs.readFileSync(path.join(root, '.env.db.local'), 'utf8'))
  validateEnvironment(values, 'local')
  const container = 'lotos-crm-local-db-1'
  const mappings = JSON.parse(command(['inspect', '--format', '{{json .NetworkSettings.Ports}}', container]))
  const port = mappings['5432/tcp']
  if (!Array.isArray(port) || port.length !== 1 || port[0].HostIp !== '127.0.0.1' || port[0].HostPort !== '55432')
    throw Error('Not the guarded Local container')
  const identity = command([
    'exec',
    container,
    'psql',
    '-U',
    'lotos_local',
    '-d',
    'lotos_crm_local',
    '-Atc',
    "SELECT current_database() || ':' || current_user;",
  ]).trim()
  if (identity !== 'lotos_crm_local:lotos_local') throw Error('Database identity differs')
  const artifacts = path.join(root, '.artifacts')
  if (fs.existsSync(artifacts) && fs.lstatSync(artifacts).isSymbolicLink())
    throw Error('Artifact root must not be a symlink')
  fs.mkdirSync(artifacts, { recursive: true })
  const directory = fs.mkdtempSync(path.join(artifacts, 'local-before-import-'))
  fs.chmodSync(directory, 0o700)
  const dump = path.join(directory, 'database.dump')
  const output = fs.openSync(dump, 'wx', 0o600)
  try {
    command(
      [
        'exec',
        container,
        'pg_dump',
        '-U',
        'lotos_local',
        '-d',
        'lotos_crm_local',
        '--format=custom',
        '--no-owner',
        '--no-acl',
      ],
      { stdio: ['ignore', output, 'pipe'] },
    )
  } finally {
    fs.closeSync(output)
  }
  const input = fs.openSync(dump, 'r')
  let catalog
  try {
    catalog = command(['exec', '-i', container, 'pg_restore', '--list'], { stdio: [input, 'pipe', 'pipe'] })
  } finally {
    fs.closeSync(input)
  }
  const bytes = fs.readFileSync(dump)
  const manifest = {
    environment: 'local',
    database: 'lotos_crm_local',
    createdAt: new Date().toISOString(),
    dumpBytes: bytes.length,
    dumpSha256: createHash('sha256').update(bytes).digest('hex'),
    catalogEntries: catalog.split('\n').filter((line) => line && !line.startsWith(';')).length,
    restoreRehearsal: false,
  }
  if (!manifest.catalogEntries || !manifest.dumpBytes) throw Error('Empty backup')
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
  console.log(JSON.stringify({ ...manifest, directory: path.relative(root, directory) }, null, 2))
} catch {
  console.error(
    'Копия Local не подтверждена. Проверьте контейнер/порт и права. Рабочая база не изменялась; неполные приватные файлы не удаляются автоматически.',
  )
  process.exitCode = 1
}
