import { createInterface } from 'node:readline/promises'
import { createPostgresClient } from '../lib/server/postgres/client'
import { bootstrapAdmin } from '../lib/server/postgres/accounts'
import { validateEnvironment } from './lib/environment.mjs'

async function hiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Bootstrap requires an interactive terminal; never pass a password as an argument')
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
          reject(new Error('Bootstrap cancelled'))
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
  if (process.argv.length !== 2 || process.env.APP_ENV !== 'local')
    throw new Error('Only the guarded local interactive bootstrap is available in this stage')
  validateEnvironment(process.env, 'local')
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  const username = await readline.question('Логин первого администратора: ')
  const name = await readline.question('Имя администратора: ')
  readline.close()
  const password = await hiddenPassword('Пароль (12–200 символов, ввод скрыт): ')
  const confirmation = await hiddenPassword('Повторите пароль: ')
  if (password !== confirmation) throw new Error('Passwords do not match')
  const db = createPostgresClient(process.env)
  try {
    const user = await bootstrapAdmin(db, { username, name, password })
    console.log('Первый администратор создан: ' + user.username)
  } finally {
    await db.$disconnect()
  }
}

main().catch(() => {
  console.error(
    'Администратор не создан. Проверьте данные/окружение и отсутствие существующего администратора. Пароли не выводятся в журнал.',
  )
  process.exitCode = 1
})
