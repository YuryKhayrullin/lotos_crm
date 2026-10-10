import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../.generated/prisma/client'
import sharp from 'sharp'
import { hashPassword } from 'better-auth/crypto'
import { validateEnvironment } from '../../scripts/lib/environment.mjs'
import { createPostgresClient } from '../../lib/server/postgres/client'
import { createPostgresAuth } from '../../lib/server/postgres/auth'
import { createPostgresRouter } from '../../lib/server/postgres/http'
import { postgresReadiness } from '../../lib/server/postgres/health'

validateEnvironment(process.env, 'test')
const container = process.env.LOTOS_TEST_CONTAINER || ''
assert.match(container, /^lotos-crm-test-[a-f0-9]{12}-db-1$/)
const dockerEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DOCKER_|PG)/.test(key))),
  NODE_ENV: process.env.NODE_ENV,
  DOCKER_HOST: 'unix:///var/run/docker.sock',
}
const docker = (args: string[], input?: Buffer) =>
  execFileSync('docker', args, {
    env: dockerEnv,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000,
  })

test('readiness detects missing/private storage without revealing paths or repairing permissions', async () => {
  const db = createPostgresClient(process.env)
  const probeId = randomUUID()
  try {
    assert.equal(await postgresReadiness(db, process.env), true)
    chmodSync(process.env.DOCUMENTS_DIR!, 0o755)
    assert.equal(await postgresReadiness(db, process.env), false)
    assert.equal(await postgresReadiness(db, { ...process.env, DOCUMENTS_DIR: '/missing' }), false)
    chmodSync(process.env.DOCUMENTS_DIR!, 0o700)
    await db.$executeRaw`INSERT INTO _prisma_migrations(id,checksum,migration_name,applied_steps_count)
      VALUES (${probeId},${'0'.repeat(64)},'readiness-unfinished-fixture',0)`
    assert.equal(await postgresReadiness(db, process.env), false, 'unfinished migration is not healthy')
  } finally {
    await db.$executeRaw`DELETE FROM _prisma_migrations WHERE id=${probeId}`
    chmodSync(process.env.DOCUMENTS_DIR!, 0o700)
    await db.$disconnect()
  }
})

test('a real SQL dump and private receipt restore on a different disposable database and pass application audit', async () => {
  const db = createPostgresClient(process.env)
  const directory = mkdtempSync(path.join(tmpdir(), 'lotos-restore-test-'))
  const restoredRoot = mkdtempSync('/tmp/lotos-crm-documents-test-')
  const target = 'lotos_restore_' + randomBytes(6).toString('hex')
  assert.match(target, /^lotos_restore_[a-f0-9]{12}$/)
  let restored: PrismaClient | undefined,
    targetCreated = false
  try {
    const password = randomBytes(32).toString('base64url'),
      username = 'restore-' + randomBytes(5).toString('hex')
    const owner = await db.user.create({
      data: { username, name: 'Fictional restoration operator', role: 'admin', status: 'active' },
    })
    await db.account.create({
      data: { userId: owner.id, accountId: owner.id, providerId: 'credential', password: await hashPassword(password) },
    })
    const branch = await db.branch.create({ data: { name: 'Fictional restoration pool', address: 'Test only' } })
    const client = await db.client.create({
      data: { branchId: branch.id, childName: 'Fictional restored pupil', parentName: 'Fictional parent' },
    })
    const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#007d99' } })
      .png()
      .toBuffer()
    const sourceRoute = createPostgresRouter(db, createPostgresAuth(db, process.env), process.env)
    const login = (route: typeof sourceRoute) =>
      route(
        new Request(process.env.APP_URL + '/api/auth/login', {
          method: 'POST',
          headers: { origin: process.env.APP_URL!, 'content-type': 'application/json' },
          body: JSON.stringify({ username, password }),
        }),
        ['auth', 'login'],
      )
    const signIn = await login(sourceRoute)
    assert.equal(signIn.status, 200)
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    const call = (route: typeof sourceRoute, action: string, payload: unknown, identity = cookie) =>
      route(
        new Request(process.env.APP_URL + '/api/crm', {
          method: 'POST',
          headers: { origin: process.env.APP_URL!, 'content-type': 'application/json', cookie: identity },
          body: JSON.stringify({ action, payload }),
        }),
        ['crm'],
      )
    assert.equal(
      (
        await call(sourceRoute, 'recordAdjustment', {
          clientId: client.id,
          lessonsDelta: 4,
          reason: 'Fictional restoration opening',
          requestId: randomUUID(),
        })
      ).status,
      200,
    )
    assert.equal(
      (
        await call(sourceRoute, 'uploadReceipt', {
          clientId: client.id,
          expectedReceiptVersion: 0,
          fileName: 'Test.png',
          mimeType: 'image/png',
          fileBase64: png.toString('base64'),
          requestId: randomUUID(),
        })
      ).status,
      200,
    )
    const document = await db.document.findFirstOrThrow({ where: { clientId: client.id } })
    const sourceBytes = readFileSync(path.join(process.env.DOCUMENTS_DIR!, 'objects', document.storageKey))
    assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), document.sha256)

    const started = performance.now()
    // This suite has no concurrent writers: SQL + files form a quiesced bundle.
    const dump = docker([
      'exec',
      container,
      'pg_dump',
      '-U',
      'lotos_test',
      '-d',
      'lotos_crm_test',
      '--format=custom',
      '--no-owner',
      '--no-acl',
    ])
    writeFileSync(path.join(directory, 'database.dump'), dump, { mode: 0o600 })
    // Preserve private directory modes, unlike fs.cp's default 0755 directories.
    execFileSync('tar', ['-cpf', path.join(directory, 'documents.tar'), '-C', process.env.DOCUMENTS_DIR!, '.'])
    execFileSync('tar', ['-xpf', path.join(directory, 'documents.tar'), '-C', restoredRoot])
    const bundleReadyMs = performance.now() - started
    const checksum = createHash('sha256').update(dump).digest('hex')
    assert.equal(
      createHash('sha256')
        .update(readFileSync(path.join(directory, 'database.dump')))
        .digest('hex'),
      checksum,
    )

    await db.$executeRawUnsafe('CREATE DATABASE ' + target)
    targetCreated = true
    docker(
      [
        'exec',
        '-i',
        container,
        'pg_restore',
        '-U',
        'lotos_test',
        '-d',
        target,
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
      ],
      dump,
    )
    const url = new URL(process.env.DATABASE_URL!)
    url.pathname = '/' + target
    // Explicit second DB on the already guarded, disposable TCP test port.
    // No application factory fallback or production/local target is allowed.
    assert.equal(url.hostname, '127.0.0.1')
    assert.equal(url.port, '55433')
    restored = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), max: 3 }) })
    assert.equal((await restored.client.findUniqueOrThrow({ where: { id: client.id } })).remainingLessons, 4)
    assert.equal((await restored.document.findUniqueOrThrow({ where: { id: document.id } })).sha256, document.sha256)
    const values = { ...process.env, DOCUMENTS_DIR: restoredRoot }
    const restoredRoute = createPostgresRouter(restored, createPostgresAuth(restored, values), values)
    const restoredLogin = await login(restoredRoute)
    assert.equal(restoredLogin.status, 200, 'restored hash/session works through the application')
    const restoredCookie = restoredLogin.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    const response = await call(
      restoredRoute,
      'getClientHistory',
      { clientId: client.id, includeAudit: true },
      restoredCookie,
    )
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).audit.discrepancies, [])
    const receipt = await restoredRoute(
      new Request(process.env.APP_URL + '/api/receipts/' + client.id, { headers: { cookie: restoredCookie } }),
      ['receipts', client.id],
    )
    assert.equal(receipt.status, 200)
    assert.deepEqual(Buffer.from(await receipt.arrayBuffer()), sourceBytes)
    // Corrupted restored bytes must fail closed, without touching original files.
    writeFileSync(path.join(restoredRoot, 'objects', document.storageKey), Buffer.alloc(sourceBytes.length))
    const corrupted = await restoredRoute(
      new Request(process.env.APP_URL + '/api/receipts/' + client.id, { headers: { cookie: restoredCookie } }),
      ['receipts', client.id],
    )
    assert.notEqual(corrupted.status, 200)
    assert.deepEqual(readFileSync(path.join(process.env.DOCUMENTS_DIR!, 'objects', document.storageKey)), sourceBytes)
    const report = {
      testedAt: new Date().toISOString(),
      environment: 'disposable-test',
      bundleReadyMs: +bundleReadyMs.toFixed(2),
      restoreAndAppVerificationMs: +(performance.now() - started - bundleReadyMs).toFixed(2),
      dumpBytes: dump.length,
      dumpChecksumVerified: true,
      loginVerified: true,
      accountingVerified: true,
      receiptVerified: true,
      corruptionRejected: true,
      offsiteCopyVerified: false,
      publicHttpsVerified: false,
    }
    mkdirSync('.artifacts', { recursive: true })
    writeFileSync('.artifacts/restore-latest.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    console.log('RESTORE ' + JSON.stringify(report))
  } finally {
    await restored?.$disconnect()
    if (targetCreated) await db.$executeRawUnsafe('DROP DATABASE ' + target + ' WITH (FORCE)')
    await db.$disconnect()
    // Only mkdtemp-owned paths, never Local/documents env-root.
    rmSync(directory, { recursive: true })
    rmSync(restoredRoot, { recursive: true })
  }
})
