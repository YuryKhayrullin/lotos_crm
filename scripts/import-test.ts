import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { validateEnvironment } from './lib/environment.mjs'
import { createPostgresClient } from '../lib/server/postgres/client'
import { applyTestImport, testImportSummary, validateTestImport } from '../lib/server/postgres/import'
import { verifyTestImport } from '../lib/server/postgres/import-verification'

async function main() {
  validateEnvironment(process.env, 'local')
  const args = process.argv.slice(2)
  const options = new Map<string, string>()
  let apply = false
  let verify = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') {
      if (apply || verify) throw Error()
      apply = true
      continue
    }
    if (args[index] === '--verify') {
      if (verify || apply) throw Error()
      verify = true
      continue
    }
    if (
      !['--source', '--namespace', '--actor', '--bindings'].includes(args[index]) ||
      !args[index + 1] ||
      options.has(args[index])
    )
      throw Error()
    options.set(args[index], args[++index])
  }
  const source = options.get('--source') || 'База данных.xlsx'
  const namespace = options.get('--namespace') || 'gas-test-2026-10-08'
  const buffer = execFileSync(
    'python3',
    ['-B', 'scripts/import-dry-run.py', source, '--emit-test-plan', '--namespace', namespace],
    { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024, timeout: 20000 },
  )
  const input = JSON.parse(buffer.toString('utf8'))
  if (options.has('--bindings')) {
    const bindings = JSON.parse(readFileSync(options.get('--bindings')!, 'utf8'))
    if (
      !bindings ||
      typeof bindings !== 'object' ||
      Object.keys(bindings).some((key) => !['coachBindings', 'rosters'].includes(key))
    )
      throw Error()
    input.coachBindings = bindings.coachBindings || {}
    input.rosters = bindings.rosters || {}
  }
  const plan = validateTestImport(input)
  if (!apply && !verify) {
    console.log(JSON.stringify(testImportSummary(plan), null, 2))
    return
  }
  if (apply && !options.has('--actor')) throw Error('Active owner must be supplied')
  const db = createPostgresClient(process.env)
  try {
    if (verify) {
      const result = await verifyTestImport(db, plan, process.env)
      console.log(JSON.stringify(result, null, 2))
      if (!result.success) process.exitCode = 2
      return
    }
    const actor = await db.user.findUnique({ where: { username: options.get('--actor')! } })
    if (!actor) throw Error()
    console.log(JSON.stringify(await applyTestImport(db, plan, actor.id, process.env), null, 2))
  } finally {
    await db.$disconnect()
  }
}
void main().catch(() => {
  console.error(
    'Импорт не выполнен: проверьте Local, исходник, namespace, явные привязки и активного владельца. Credentials/значения источника не выводятся.',
  )
  process.exitCode = 1
})
