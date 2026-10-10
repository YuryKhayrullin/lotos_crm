import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { FixtureBlob } from './blob-fixture'

const key = 'a'.repeat(32),
  bytes = Buffer.from('fictional-private-document')
const digest = createHash('sha256').update(bytes).digest('hex')
test('private Blob setup is explicit and readiness never creates a file', async () => {
  const fixture = new FixtureBlob(),
    storage = fixture.store()
  assert.equal(await storage.ready(), false)
  assert.equal(fixture.puts, 0)
  await storage.setup()
  await storage.setup()
  assert.equal(fixture.puts, 1)
  assert.equal(await storage.ready(), true)
})
test('private Blob exclusive retries survive lost acknowledgement and a new process without overwriting', async () => {
  const fixture = new FixtureBlob(),
    storage = fixture.store()
  await storage.setup()
  fixture.loseReply = true
  await storage.persist(key, bytes)
  const restart = fixture.store()
  await restart.persist(key, bytes)
  assert.equal(fixture.puts, 2) // one marker + one document
  assert.deepEqual(await restart.read(key, digest, bytes.length), bytes)
  await assert.rejects(restart.persist(key, Buffer.from('different-original')))
  assert.equal(fixture.puts, 2)
})
test('public/wrong Blob identity and arbitrary keys fail closed before document writes', async () => {
  const fixture = new FixtureBlob(),
    storage = fixture.store()
  await storage.setup()
  fixture.publicUrl = true
  await assert.rejects(storage.persist(key, bytes))
  assert.equal(fixture.puts, 1)
  assert.equal(await storage.ready(), false)
  const reads = fixture.gets
  for (const malicious of ['../private', 'https://evil.example/test', 'b'.repeat(100)])
    await assert.rejects(storage.read(malicious, digest, bytes.length))
  assert.equal(fixture.gets, reads)
})
test('corrupt private bytes, forbidden reads and oversize content do not masquerade as missing/success', async () => {
  const fixture = new FixtureBlob(),
    storage = fixture.store()
  await storage.setup()
  await storage.persist(key, bytes)
  fixture.files.set('lotos-crm/staging/objects/' + key, Buffer.from('x'.repeat(bytes.length)))
  await assert.rejects(storage.read(key, digest, bytes.length))
  await assert.rejects(storage.persist(key, bytes))
  fixture.unreadable = true
  await assert.rejects(storage.read(key, digest, bytes.length))
  assert.equal(await storage.ready(), false)
  fixture.unreadable = false
  await assert.rejects(storage.persist('b'.repeat(32), Buffer.alloc(storage.maxBytes + 1)))
  assert.equal(fixture.puts, 2)
})
