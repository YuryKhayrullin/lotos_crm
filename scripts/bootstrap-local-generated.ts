// Operator-only alternative for a TEST Local installation. It never resets an
// existing administrator and is not exposed through an HTTP auth route.
import { randomBytes } from 'node:crypto'
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPassword } from 'better-auth/crypto'
import { bootstrapAdminSchema } from '../lib/server/postgres/auth-input'
import { bootstrapAdmin } from '../lib/server/postgres/accounts'
import { createPostgresClient } from '../lib/server/postgres/client'
import { parseEnv, validateEnvironment } from './lib/environment.mjs'

async function main() {
  if (process.argv.length !== 2 || (process.env.APP_ENV && process.env.APP_ENV !== 'local')) throw Error()
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const values = parseEnv(readFileSync(path.join(root, '.env.db.local'), 'utf8')) as NodeJS.ProcessEnv
  validateEnvironment(values, 'local')
  const db = createPostgresClient(values)
  try {
    const directory = path.join(root, '.artifacts')
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw Error()
    mkdirSync(directory, { recursive: true })
    const accessFile = path.join(directory, 'local-admin-access.json')
    const existingAdmins = await db.user.count({ where: { role: 'admin' } })
    if (!existsSync(accessFile)) {
      if (existingAdmins) throw Error()
      const input = bootstrapAdminSchema.parse({
        username: 'local-admin',
        name: 'Администратор Local',
        password: randomBytes(32).toString('base64url'),
      })
      // Persist credentials BEFORE SQL, so a lost commit acknowledgement
      // cannot strand the only admin. Never write an existing file.
      const fd = openSync(accessFile, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify(input, null, 2) + '\n')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    const fd = openSync(accessFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    let input
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw Error()
      input = bootstrapAdminSchema.parse(JSON.parse(readFileSync(fd, 'utf8')))
    } finally {
      closeSync(fd)
    }
    const confirmed = async () => {
      const user = await db.user.findUnique({
        where: { username: input.username },
        include: { accounts: { where: { providerId: 'credential' } } },
      })
      if (!user || user.role !== 'admin' || user.status !== 'active' || user.accounts.length !== 1) return false
      const hash = user.accounts[0].password
      return !!hash && (await verifyPassword({ password: input.password, hash }))
    }
    if (existingAdmins) {
      if (!(await confirmed())) throw Error()
    } else {
      try {
        await bootstrapAdmin(db, input)
      } catch {
        // Read-only acknowledgement recovery; never a password reset.
        if (!(await confirmed())) throw Error()
      }
    }
    if (!(await confirmed())) throw Error()
    console.log(
      JSON.stringify({
        environment: 'local',
        username: input.username,
        accessFile: path.relative(root, accessFile),
        duplicate: existingAdmins > 0,
        passwordPrinted: false,
      }),
    )
  } finally {
    await db.$disconnect()
  }
}
void main().catch(() => {
  console.error(
    'Local bootstrap не подтверждён. Существующие аккаунты/пароли не сбрасываются. Проверьте Local и приватный файл доступа; его содержимое не выводится.',
  )
  process.exitCode = 1
})
