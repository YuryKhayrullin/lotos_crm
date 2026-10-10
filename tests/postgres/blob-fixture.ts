import assert from 'node:assert/strict'
import { PrivateBlobStorage, type BlobTransport } from '../../lib/server/postgres/blob-storage'

export class FixtureBlob implements BlobTransport {
  readonly files = new Map<string, Buffer>()
  puts = 0
  gets = 0
  loseReply = false
  publicUrl = false
  unreadable = false
  readonly storeId = 'store_fictional123'
  private url(pathname: string) {
    return 'https://fictional123.' + (this.publicUrl ? 'public' : 'private') + '.blob.vercel-storage.com/' + pathname
  }
  async get(pathname: string, options: Parameters<BlobTransport['get']>[1]) {
    this.gets++
    assert.equal(options.access, 'private')
    assert.equal(options.useCache, false)
    assert.equal(options.storeId, this.storeId)
    if (this.unreadable) throw new Error('Cloud unavailable; internal URL/token must never reach API')
    const bytes = this.files.get(pathname)
    if (!bytes) return null
    return {
      statusCode: 200,
      blob: { url: this.url(pathname), pathname, size: bytes.length },
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes))
          controller.close()
        },
      }),
    }
  }
  async put(pathname: string, bytes: Buffer, options: Parameters<BlobTransport['put']>[2]) {
    assert.equal(options.access, 'private')
    assert.equal(options.allowOverwrite, false)
    assert.equal(options.addRandomSuffix, false)
    assert.equal(options.storeId, this.storeId)
    assert.ok(options.abortSignal)
    if (this.files.has(pathname)) throw new Error('Already exists')
    this.puts++
    this.files.set(pathname, Buffer.from(bytes))
    if (this.loseReply) {
      this.loseReply = false
      throw new Error('Lost committed Blob reply')
    }
    return { pathname, url: this.url(pathname) }
  }
  store() {
    return new PrivateBlobStorage(this.storeId, this)
  }
}
