import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { hashPassword } from 'better-auth/crypto'
import { validateEnvironment } from '../../scripts/lib/environment.mjs'
import { createPostgresClient } from '../../lib/server/postgres/client'
import { createPostgresAuth } from '../../lib/server/postgres/auth'
import { createPostgresRouter } from '../../lib/server/postgres/http'
import { inspectDocumentUploads, documentRoot } from '../../lib/server/postgres/documents'
import { authDigest } from '../../lib/server/postgres/accounts'
import { createHash } from 'node:crypto'
import { FixtureBlob } from './blob-fixture'
import { postgresReadiness } from '../../lib/server/postgres/health'

validateEnvironment(process.env, 'test')
const db = createPostgresClient(process.env),
  route = createPostgresRouter(db, createPostgresAuth(db, process.env), process.env),
  password = randomBytes(24).toString('hex')
let admin = '',
  coach = '',
  branch = '',
  png: Buffer
async function request(segments: string[], body?: unknown, cookie = admin, method = 'POST') {
  return route(
    new Request(process.env.APP_URL + '/api/' + segments.join('/'), {
      method,
      headers: { origin: process.env.APP_URL!, 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    segments,
  )
}
async function crm(action: string, payload: unknown, cookie = admin) {
  return request(['crm'], { action, payload }, cookie)
}
async function ok(action: string, payload: unknown) {
  const response = await crm(action, payload)
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  return response.json()
}
async function card() {
  return ok('createClient', {
    requestId: randomUUID(),
    branchId: branch,
    childName: 'Document fictional pupil',
    parentName: 'Test parent',
  })
}
const input = (clientId: string, extra = {}) => ({
  clientId,
  requestId: randomUUID(),
  expectedReceiptVersion: 0,
  fileName: 'Тестовая квитанция.png',
  mimeType: 'image/png',
  fileBase64: png.toString('base64'),
  ...extra,
})
async function upload(data: ReturnType<typeof input>, cookie = admin) {
  return request(['receipts', data.clientId], data, cookie)
}
async function saved(data: ReturnType<typeof input>) {
  const response = await upload(data)
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  return response.json()
}
before(async () => {
  branch = (await db.branch.create({ data: { name: 'Document test branch', address: 'Fictional' } })).id
  for (const role of ['admin', 'coach'] as const) {
    const user = await db.user.create({
      data: {
        username: 'documents-' + role,
        name: 'Document test account',
        role,
        status: 'active',
        branchId: role === 'coach' ? branch : null,
      },
    })
    await db.account.create({
      data: { userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) },
    })
    const response = await request(['auth', 'login'], { username: user.username, password }, '')
    assert.equal(response.status, 200)
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    if (role === 'admin') admin = cookie
    else coach = cookie
  }
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00bbaa' } })
    .png()
    .toBuffer()
})
after(async () => {
  await db.$disconnect()
})
test('disabled cloud receipts reject all direct/envelope routes without storage access or SQL document writes', async () => {
  const client = await card()
  const beforeCounts = [await db.document.count(), await db.documentUpload.count()]
  // SQL/auth are injected from isolated Test; the cloud profile is fictional
  // and never passed to a connection factory or a remote storage transport.
  const values: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    APP_ENV: 'staging',
    DEPLOY_TARGET: 'vercel',
    CRM_BACKEND: 'postgres',
    APP_URL: 'https://lotos-fictional-staging.vercel.app',
    CLOUD_DATABASE_HOST: 'ep-fictional-pooler.eu-central-1.aws.neon.tech',
    DATABASE_URL: `postgresql://lotos_runtime:${'1'.repeat(64)}@ep-fictional-pooler.eu-central-1.aws.neon.tech:5432/lotos_crm_staging?sslmode=verify-full`,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET!,
    DOCUMENT_STORAGE: 'disabled',
    COACH_REGISTRATION_ENABLED: 'false',
    TRUSTED_PROXY: 'vercel',
  }
  const noFiles = createPostgresRouter(db, createPostgresAuth(db, process.env), values, {
    documentStorage: {
      maxBytes: 3 * 1024 * 1024,
      initialize: async () => {
        throw Error('Storage must not be contacted')
      },
      persist: async () => {
        throw Error('Storage must not be contacted')
      },
      read: async () => {
        throw Error('Storage must not be contacted')
      },
    },
  })
  const calls = [
    { segments: ['receipts', client.id], method: 'GET' },
    { segments: ['receipts', client.id], method: 'POST', body: {} },
    { segments: ['receipts', client.id, 'attempts'], method: 'GET' },
    {
      segments: ['receipts', client.id, 'attempts'],
      method: 'POST',
      body: { requestId: 'never-created', discard: true },
    },
    { segments: ['crm'], method: 'POST', body: { action: 'uploadReceipt', payload: {} } },
    { segments: ['crm'], method: 'POST', body: { action: 'getReceipt', payload: { clientId: client.id } } },
  ]
  for (const call of calls) {
    const response = await noFiles(
      new Request(values.APP_URL + '/api/' + call.segments.join('/'), {
        method: call.method,
        headers: { cookie: admin, origin: values.APP_URL!, 'content-type': 'application/json' },
        ...(call.body ? { body: JSON.stringify(call.body) } : {}),
      }),
      call.segments,
    )
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'FEATURE_DISABLED')
    assert.equal(response.headers.get('x-crm-receipt-max-bytes'), '0')
  }
  assert.deepEqual([await db.document.count(), await db.documentUpload.count()], beforeCounts)
  assert.equal(
    (await noFiles(new Request(values.APP_URL + '/api/receipts/' + client.id), ['receipts', client.id])).status,
    401,
  )
})
test('disabled Vercel readiness requires SQL schema but not a Blob marker or local document directory', async () => {
  const values: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    APP_ENV: 'staging',
    DEPLOY_TARGET: 'vercel',
    CRM_BACKEND: 'postgres',
    APP_URL: 'https://lotos-fictional-staging.vercel.app',
    CLOUD_DATABASE_HOST: 'ep-fictional-pooler.eu-central-1.aws.neon.tech',
    DATABASE_URL: `postgresql://lotos_runtime:${'1'.repeat(64)}@ep-fictional-pooler.eu-central-1.aws.neon.tech:5432/lotos_crm_staging?sslmode=verify-full`,
    BETTER_AUTH_SECRET: '3'.repeat(64),
    DOCUMENT_STORAGE: 'disabled',
    COACH_REGISTRATION_ENABLED: 'false',
    TRUSTED_PROXY: 'vercel',
  }
  assert.equal(await postgresReadiness(db, values), true)
  assert.equal(await postgresReadiness(db, { ...values, DOCUMENT_STORAGE: '' }), false)
})
test('real SQL with private Blob transport preserves intent/recovery across failed commit and new router', async () => {
  const fixture = new FixtureBlob(),
    storage = fixture.store()
  await storage.setup()
  let cloud = createPostgresRouter(db, createPostgresAuth(db, process.env), process.env, { documentStorage: storage })
  const call = (segments: string[], body?: unknown, cookie = admin, method = 'POST') =>
    cloud(
      new Request(process.env.APP_URL + '/api/' + segments.join('/'), {
        method,
        headers: { cookie, origin: process.env.APP_URL!, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      segments,
    )
  const client = await card(),
    data = input(client.id)
  await db.$executeRawUnsafe(
    `CREATE FUNCTION fail_cloud_document_attach() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fictional cloud SQL fault'; END $$`,
  )
  await db.$executeRawUnsafe(
    `CREATE TRIGGER fail_cloud_document_attach BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION fail_cloud_document_attach()`,
  )
  try {
    const failure = await call(['receipts', client.id], data)
    assert.equal(failure.status, 503)
    assert.equal((await failure.json()).code, 'SERVICE_UNAVAILABLE')
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER fail_cloud_document_attach ON documents')
    await db.$executeRawUnsafe('DROP FUNCTION fail_cloud_document_attach()')
  }
  assert.equal(await db.document.count({ where: { clientId: client.id } }), 0)
  assert.equal(fixture.puts, 2)
  cloud = createPostgresRouter(db, createPostgresAuth(db, process.env), process.env, {
    documentStorage: fixture.store(),
  })
  const inbox = await call(['receipts', client.id, 'attempts'], undefined, admin, 'GET')
  assert.equal((await inbox.json()).attempts[0].resumable, true)
  const resumed = await call(['receipts', client.id, 'attempts'], { requestId: data.requestId })
  assert.equal(resumed.status, 200)
  assert.equal(resumed.headers.get('x-crm-receipt-max-bytes'), String(3 * 1024 * 1024))
  assert.equal((await call(['receipts', client.id], data)).status, 200)
  assert.equal(await db.document.count({ where: { clientId: client.id } }), 1)
  const receipt = await call(['receipts', client.id], undefined, admin, 'GET')
  assert.deepEqual(Buffer.from(await receipt.arrayBuffer()), png)
  const puts = fixture.puts,
    gets = fixture.gets
  assert.equal((await call(['receipts', client.id], undefined, coach, 'GET')).status, 403)
  assert.equal(fixture.gets, gets)
  assert.equal(fixture.puts, puts)
})
test('cloud-specific receipt byte limit rejects oversized uploads before SQL intents or Blob writes', async () => {
  const fixture = new FixtureBlob(),
    storage = fixture.store()
  await storage.setup()
  const cloud = createPostgresRouter(db, createPostgresAuth(db, process.env), process.env, { documentStorage: storage })
  const client = await card()
  const data = input(client.id, { fileBase64: Buffer.alloc(storage.maxBytes + 1).toString('base64') })
  const response = await cloud(
    new Request(process.env.APP_URL + '/api/receipts/' + client.id, {
      method: 'POST',
      headers: { cookie: admin, origin: process.env.APP_URL!, 'content-type': 'application/json' },
      body: JSON.stringify(data),
    }),
    ['receipts', client.id],
  )
  assert.equal(response.status, 413)
  assert.equal(await db.documentUpload.count({ where: { clientId: client.id } }), 0)
  assert.equal(fixture.puts, 1)
})
test('receipt is private, downloaded as attachment, byte-exact and never grants credits', async () => {
  const client = await card(),
    data = input(client.id)
  await saved(data)
  const result = await request(['receipts', client.id], undefined, admin, 'GET')
  assert.equal(result.status, 200)
  assert.match(result.headers.get('content-disposition')!, /^attachment/)
  assert.equal(result.headers.get('cache-control'), 'private, no-store')
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff')
  assert.ok(Buffer.from(await result.arrayBuffer()).equals(png))
  const row = await db.client.findUniqueOrThrow({ where: { id: client.id } })
  assert.equal(row.remainingLessons, 0)
  assert.equal(row.paidAmountMinor, BigInt(0))
  assert.equal(await db.payment.count({ where: { clientId: row.id } }), 0)
  const document = await db.document.findFirstOrThrow({ where: { clientId: row.id } })
  assert.equal((await fs.stat(path.join(documentRoot(process.env), 'objects', document.storageKey))).mode & 0o077, 0)
  assert.equal((await upload(input(client.id), coach)).status, 403)
  assert.equal((await request(['receipts', client.id], undefined, coach, 'GET')).status, 403)
  assert.equal((await request(['receipts', client.id], undefined, '', 'GET')).status, 401)
})
test('durable repeat cannot replace a more recent receipt; stale new uploads conflict', async () => {
  const client = await card(),
    first = input(client.id),
    second = input(client.id, { expectedReceiptVersion: 1, fileName: 'New.png' })
  await saved(first)
  await saved(second)
  await saved(first)
  const current = await db.client.findUniqueOrThrow({ where: { id: client.id }, include: { currentReceipt: true } })
  assert.equal(current.currentReceipt!.originalName, 'New.png')
  assert.equal(current.receiptVersion, 2)
  assert.equal(await db.document.count({ where: { clientId: client.id } }), 2)
  assert.equal((await upload(input(client.id))).status, 409)
  assert.equal((await upload({ ...first, fileName: 'Changed.png' })).status, 409)
})
test('signature, decoded size, path-shaped name and mismatched MIME are rejected before attachment', async () => {
  const client = await card()
  for (const extra of [
    { fileBase64: '!!!=' },
    { fileBase64: Buffer.from('<script>alert(1)</script>').toString('base64') },
    { fileName: '../secret.png' },
    { mimeType: 'image/jpeg' },
    { fileBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') },
  ]) {
    const response = await upload(input(client.id, extra))
    assert.ok(
      [400, 413].includes(response.status),
      JSON.stringify({ fields: Object.keys(extra), status: response.status, error: await response.clone().json() }),
    )
  }
  assert.equal(await db.document.count({ where: { clientId: client.id } }), 0)
  assert.equal(await db.documentUpload.count({ where: { clientId: client.id } }), 0)
})
test('structurally valid PDF is accepted while active actions and truncated PDF are rejected', async () => {
  const client = await card(),
    document = await PDFDocument.create()
  document.addPage()
  const bytes = Buffer.from(await document.save())
  await saved(
    input(client.id, { mimeType: 'application/pdf', fileName: 'Receipt.pdf', fileBase64: bytes.toString('base64') }),
  )
  const malicious = await PDFDocument.create()
  malicious.addPage()
  malicious.catalog.set(
    PDFName.of('OpenAction'),
    malicious.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }),
  )
  const bad = Buffer.from(await malicious.save())
  assert.equal(
    (
      await upload(
        input(client.id, {
          expectedReceiptVersion: 1,
          mimeType: 'application/pdf',
          fileName: 'Bad.pdf',
          fileBase64: bad.toString('base64'),
        }),
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await upload(
        input(client.id, {
          expectedReceiptVersion: 1,
          mimeType: 'application/pdf',
          fileName: 'Broken.pdf',
          fileBase64: Buffer.from('%PDF-1.7\nnot a document').toString('base64'),
        }),
      )
    ).status,
    400,
  )
})
test('SQL failure after file persistence keeps old receipt and a recoverable private orphan', async () => {
  const client = await card()
  await saved(input(client.id))
  const pending = input(client.id, { expectedReceiptVersion: 1, fileName: 'Retry.png' })
  await db.$executeRawUnsafe(
    "CREATE FUNCTION test_document_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='uploadReceipt' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$",
  )
  await db.$executeRawUnsafe(
    'CREATE TRIGGER test_document_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_document_audit_failure()',
  )
  try {
    assert.equal((await upload(pending)).status, 503)
    const current = await db.client.findUniqueOrThrow({ where: { id: client.id }, include: { currentReceipt: true } })
    assert.equal(current.currentReceipt!.originalName, 'Тестовая квитанция.png')
    assert.equal(current.receiptVersion, 1)
    const report = await inspectDocumentUploads(db, process.env)
    assert.ok(report.uploads.some((row) => row.clientId === client.id && row.filePresent))
    assert.equal(await db.mutationRequest.count({ where: { requestKey: pending.requestId } }), 0)
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER test_document_audit_failure ON audit_events')
    await db.$executeRawUnsafe('DROP FUNCTION test_document_audit_failure()')
  }
  const attemptResponse = await request(['receipts', client.id, 'attempts'], undefined, admin, 'GET')
  assert.equal(attemptResponse.status, 200)
  const attempts = (await attemptResponse.json()).attempts
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].resumable, true)
  assert.equal(attempts[0].requestId, pending.requestId)
  assert.equal((await request(['receipts', client.id, 'attempts'], { requestId: pending.requestId })).status, 200)
  assert.equal((await request(['receipts', client.id, 'attempts'], { requestId: pending.requestId })).status, 200)
  assert.equal(await db.document.count({ where: { clientId: client.id } }), 2)
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: client.id } })).receiptVersion, 2)
})
test('file corruption fails closed and arbitrary storage roots cannot target production paths', async () => {
  assert.throws(() => documentRoot({ ...process.env, DOCUMENTS_DIR: '/var/lib/lotos-crm/documents/production' }))
  const client = await card()
  await saved(input(client.id))
  const document = await db.document.findFirstOrThrow({ where: { clientId: client.id } })
  await fs.writeFile(path.join(documentRoot(process.env), 'objects', document.storageKey), 'Test corruption')
  assert.equal((await request(['receipts', client.id], undefined, admin, 'GET')).status, 503)
})

test('pending recovery is owner-scoped; closing an attempt retains files and never undoes confirmed attachment', async () => {
  const client = await card(),
    data = input(client.id)
  const user = await db.user.findUniqueOrThrow({ where: { username: 'documents-admin' } })
  const payload = {
    clientId: client.id,
    expectedReceiptVersion: 0,
    fileName: data.fileName,
    mimeType: data.mimeType,
    sha256: createHash('sha256').update(png).digest('hex'),
    sizeBytes: png.length,
  }
  await db.documentUpload.create({
    data: {
      actorId: user.id,
      clientId: client.id,
      requestKey: data.requestId,
      storageKey: randomUUID().replaceAll('-', ''),
      fingerprint: authDigest(process.env.BETTER_AUTH_SECRET!, 'domain-mutation', { action: 'uploadReceipt', payload }),
      payload,
    },
  })
  assert.equal((await request(['receipts', client.id, 'attempts'], undefined, coach, 'GET')).status, 403)
  const pending = (await (await request(['receipts', client.id, 'attempts'], undefined, admin, 'GET')).json()).attempts
  assert.equal(pending.length, 1)
  assert.equal(pending[0].resumable, false)
  const close = await request(['receipts', client.id, 'attempts'], { requestId: data.requestId, discard: true })
  assert.equal(close.status, 200)
  assert.equal((await upload(data)).status, 409)
  assert.equal(await db.document.count({ where: { clientId: client.id } }), 0)
  const confirmed = input(client.id)
  await saved(confirmed)
  const retain = await request(['receipts', client.id, 'attempts'], { requestId: confirmed.requestId, discard: true })
  assert.equal((await retain.json()).alreadyConfirmed, true)
  assert.equal((await request(['receipts', client.id], undefined, admin, 'GET')).status, 200)
  assert.equal(await db.document.count({ where: { clientId: client.id } }), 1)
})
