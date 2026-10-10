import { validateEnvironment } from './lib/environment.mjs'
import { createPostgresClient } from '../lib/server/postgres/client'
import { inspectDocumentUploads } from '../lib/server/postgres/documents'

async function main() {
  validateEnvironment(process.env, 'local')
  const db = createPostgresClient(process.env)
  try {
    console.log(JSON.stringify(await inspectDocumentUploads(db, process.env), null, 2))
  } finally {
    await db.$disconnect()
  }
}
void main().catch(() => {
  console.error('Не удалось проверить незавершённые документы; подробности подключения не выводятся')
  process.exitCode = 1
})
