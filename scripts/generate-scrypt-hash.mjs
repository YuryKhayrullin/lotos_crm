import { randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const MIN_LENGTH = 8
const MAX_LENGTH = 200
const N = 16_384
const R = 8
const P = 1
const KEY_BYTES = 64

async function readHiddenPassword(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Запустите команду в интерактивном терминале')
  }
  process.stdout.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')

  return new Promise((resolve, reject) => {
    let value = ''
    const finish = () => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener('data', onData)
      process.stdout.write('\n')
      resolve(value)
    }
    const onData = (chunk) => {
      if (chunk === '\u0003') {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdin.removeListener('data', onData)
        reject(new Error('Отменено'))
      } else if (chunk === '\r' || chunk === '\n') {
        finish()
      } else if (chunk === '\u007f' || chunk === '\b') {
        value = value.slice(0, -1)
      } else if (!/[\u0000-\u001f]/.test(chunk)) {
        value += chunk
      }
    }
    process.stdin.on('data', onData)
  })
}

try {
  const password = await readHiddenPassword('Новый пароль: ')
  if (password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
    throw new Error('Пароль должен содержать от 8 до 200 символов')
  }
  const salt = randomBytes(16)
  const hash = Buffer.from(await scrypt(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 }))
  process.stdout.write(['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$') + '\n')
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
}
