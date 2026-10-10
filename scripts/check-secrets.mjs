import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lotos-secret-check-'))
const localExecutable = path.join(root, '.tools', 'gitleaks')
const executable = process.env.GITLEAKS_BIN || (fs.existsSync(localExecutable) ? localExecutable : 'gitleaks')
function run(binary, args, cwd = root) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8' })
  if (result.error) throw new Error('Cannot execute ' + path.basename(binary) + '; no credentials logged')
  if (result.status !== 0) {
    const reportIndex = args.indexOf('--report-path')
    const report = reportIndex >= 0 ? args[reportIndex + 1] : null
    if (report && fs.existsSync(report)) {
      const findings = JSON.parse(fs.readFileSync(report, 'utf8'))
      console.error(
        JSON.stringify({
          findings: findings.length,
          locations: findings.map((item) => ({
            rule: item.RuleID,
            file: item.File.replace(scanPrefix(), ''),
            line: item.StartLine,
          })),
        }),
      )
    }
    throw new Error('Secret check failed; no secret values logged')
  }
  return result.stdout
}
function scanPrefix() {
  return path.join(temporary, 'worktree') + path.sep
}
try {
  run(executable, ['version'])
  const tracked = run('git', ['ls-files', '-z']).split('\0').filter(Boolean)
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  const scanRoot = path.join(temporary, 'worktree')
  fs.mkdirSync(scanRoot, { mode: 0o700 })
  for (const relative of new Set([...tracked, ...untracked])) {
    if (/(^|\/)\.env($|\.)/.test(relative) && !relative.endsWith('.example'))
      throw new Error('A real env file is not excluded by Git')
    const source = path.join(root, relative)
    if (!fs.existsSync(source)) continue
    if (!fs.lstatSync(source).isFile()) throw new Error('Unexpected non-file Git entry')
    const target = path.join(scanRoot, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.copyFileSync(source, target)
  }
  run(executable, [
    'git',
    '--redact',
    '--no-banner',
    '--log-level',
    'error',
    '--log-opts=--all --full-history',
    '--report-format',
    'json',
    '--report-path',
    path.join(temporary, 'history.json'),
  ])
  run(executable, [
    'dir',
    scanRoot,
    '--redact',
    '--no-banner',
    '--log-level',
    'error',
    '--report-format',
    'json',
    '--report-path',
    path.join(temporary, 'worktree.json'),
  ])
  console.log('Gitleaks: full Git history and current tracked/untracked non-ignored files passed')
  console.log('Ignored private env files are not copied or printed; scan is not proof that no secret can exist')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  // This script owns the unique temporary directory; never a repository root.
  fs.rmSync(temporary, { recursive: true, force: true })
}
