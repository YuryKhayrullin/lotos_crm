import fs from 'node:fs'

const envFile = '.env.local'
if (!fs.existsSync(envFile)) {
  console.error('Не найден .env.local')
  process.exit(1)
}

const values = Object.fromEntries(
  fs
    .readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.trim().startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=')
      return index === -1 ? [line.trim(), ''] : [line.slice(0, index).trim(), line.slice(index + 1).trim()]
    }),
)

const failures = []
const gasUrl = values.GAS_WEBAPP_URL || ''
try {
  const url = new URL(gasUrl)
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || !url.pathname.endsWith('/exec')) {
    failures.push('GAS_WEBAPP_URL должен быть HTTPS URL Google Web App и заканчиваться на /exec')
  }
} catch {
  failures.push('GAS_WEBAPP_URL имеет некорректный формат')
}

if (!values.GAS_API_SECRET || values.GAS_API_SECRET.length < 32 || values.GAS_API_SECRET === 'insert_secret_key_here') {
  failures.push('GAS_API_SECRET должен содержать минимум 32 символа')
}
if (!values.SESSION_SECRET || values.SESSION_SECRET.length < 32 || values.SESSION_SECRET === 'insert_secret_key_here') {
  failures.push('SESSION_SECRET должен содержать минимум 32 символа')
}

if (failures.length) {
  console.error(failures.map((failure) => `✗ ${failure}`).join('\n'))
  process.exit(1)
}

console.log('✓ Локальная конфигурация GAS и сессии выглядит корректно')
console.log('! Это не проверяет Script Properties и опубликованный GAS deployment')
