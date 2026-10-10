import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { hashPassword } from 'better-auth/crypto'
import { bootstrapAdminSchema } from '../lib/server/postgres/auth-input'
import { validateEnvironment } from './lib/environment.mjs'
import { BootstrapInputError, bootstrapValidationError, bootstrapFailureMessage } from './lib/bootstrap-feedback.mjs'
import { buildBootstrapSqlEditorSql } from './lib/bootstrap-sql'

const outputFile = resolve('.private/supabase-first-admin.sql')

async function hiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new BootstrapInputError('INTERACTIVE_REQUIRED')
  process.stdout.write(prompt)
  process.stdin.setEncoding('utf8')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolvePassword, reject) => {
    let value = ''
    const finish = () => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003' || char === '\u0004') {
          finish()
          reject(new BootstrapInputError('CANCELLED'))
          return
        }
        if (char === '\r' || char === '\n') {
          finish()
          resolvePassword(value)
          return
        }
        if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join('')
        else value += char
      }
    }
    process.stdin.on('data', onData)
  })
}

async function main() {
  if (
    process.argv.length !== 2 ||
    process.env.APP_ENV !== 'staging' ||
    process.env.DEPLOY_TARGET !== 'vercel' ||
    process.env.CLOUD_DATABASE_PROVIDER !== 'supabase' ||
    process.env.BOOTSTRAP_CLOUD_ADMIN !== 'sql-editor'
  )
    throw Error('SQL Editor bootstrap is restricted to explicit Supabase staging')
  validateEnvironment(process.env, 'staging')
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new BootstrapInputError('INTERACTIVE_REQUIRED')

  const readline = createInterface({ input: process.stdin, output: process.stdout })
  let username: string, name: string
  try {
    username = await readline.question('Логин первого администратора: ')
    name = await readline.question('Имя администратора: ')
  } finally {
    readline.close()
  }
  const password = await hiddenPassword('Пароль (12–200 символов, ввод скрыт): ')
  const confirmation = await hiddenPassword('Повторите пароль: ')
  if (password !== confirmation) throw new BootstrapInputError('PASSWORD_MISMATCH')
  const parsed = bootstrapAdminSchema.safeParse({ username, name, password })
  if (!parsed.success) throw bootstrapValidationError(parsed.error.issues)

  const { sql } = buildBootstrapSqlEditorSql(parsed.data, await hashPassword(parsed.data.password))
  mkdirSync(resolve('.private'), { recursive: true, mode: 0o700 })
  writeFileSync(outputFile, sql, { encoding: 'utf8', mode: 0o600 })
  chmodSync(outputFile, 0o600)
  console.log('Приватный SQL-файл подготовлен: ' + outputFile)
  console.log('Он ещё не создаёт аккаунт. Выполните весь файл один раз в SQL Editor staging-проекта Supabase.')
}

main().catch((error) => {
  console.error(
    bootstrapFailureMessage(error, {
      phase: 'input',
      confirmed: false,
      step: undefined,
      elapsedMs: undefined,
    }),
  )
  process.exitCode = 1
})
