import { createInterface } from 'node:readline/promises'
import { createPostgresClient } from '../lib/server/postgres/client'
import { bootstrapAdmin } from '../lib/server/postgres/accounts'
import { validateEnvironment } from './lib/environment.mjs'
import { bootstrapAdminSchema } from '../lib/server/postgres/auth-input'
import { PostgresApiError } from '../lib/server/postgres/errors'
import { BootstrapInputError, bootstrapValidationError, bootstrapFailureMessage } from './lib/bootstrap-feedback.mjs'
import { bootstrapAdminLibpq, checkBootstrapLibpq, requireBootstrapOpen } from './lib/bootstrap-libpq'

let phase = 'configuration'
let confirmed = false
let step: string | undefined
let creationStarted: number | undefined

async function hiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new BootstrapInputError('INTERACTIVE_REQUIRED')
  process.stdout.write(prompt)
  process.stdin.setEncoding('utf8')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
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
          resolve(value)
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
  const local = process.env.APP_ENV === 'local'
  const cloud =
    process.env.APP_ENV === 'staging' &&
    process.env.DEPLOY_TARGET === 'vercel' &&
    process.env.BOOTSTRAP_CLOUD_ADMIN === 'explicit-operator'
  if (process.argv.length !== 2 || (!local && !cloud))
    throw new Error('Only guarded Local or explicit owner cloud bootstrap is available')
  validateEnvironment(process.env, local ? 'local' : 'staging')
  if (cloud && process.env.CLOUD_DATABASE_PROVIDER === 'supabase') throw new BootstrapInputError('SQL_EDITOR_REQUIRED')
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new BootstrapInputError('INTERACTIVE_REQUIRED')
  const libpq = cloud && process.env.CLOUD_DATABASE_PROVIDER === 'supabase'
  const db = libpq ? undefined : createPostgresClient(process.env)
  let failure: unknown
  try {
    phase = 'preflight'
    // Fail before asking for a password if SQL is unavailable or an admin exists.
    // The transaction in bootstrapAdmin repeats this check under its lock.
    if (libpq) {
      console.log('Проверка PostgreSQL через psql (Session pooler), без Prisma bootstrap.')
      requireBootstrapOpen(checkBootstrapLibpq(process.env))
    } else if (await db!.user.count({ where: { role: 'admin' } })) {
      throw new PostgresApiError(409, 'CONFLICT', 'Первый администратор уже существует')
    }
    phase = 'input'
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
    phase = 'creation'
    creationStarted = Date.now()
    const user = libpq
      ? await bootstrapAdminLibpq(process.env, parsed.data)
      : await bootstrapAdmin(db!, parsed.data, (current) => {
          step = current
        })
    confirmed = true
    phase = 'disconnect'
    console.log('Первый администратор создан: ' + user.username)
  } catch (error) {
    failure = error
  } finally {
    try {
      await db?.$disconnect()
    } catch (error) {
      failure ??= error
    }
  }
  if (failure) throw failure
}

main().catch((error) => {
  console.error(
    bootstrapFailureMessage(error, {
      phase,
      confirmed,
      step,
      elapsedMs: creationStarted === undefined ? undefined : Date.now() - creationStarted,
    }),
  )
  process.exitCode = 1
})
