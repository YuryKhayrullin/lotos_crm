import 'server-only'
import { createHash } from 'node:crypto'
import { get, put } from '@vercel/blob'
import { validateEnvironment } from '../../../scripts/lib/environment.mjs'
import { VERCEL_RECEIPT_BYTES } from '../../receipt-limits'
import { PostgresApiError } from './errors'

export interface DocumentStorage {
  readonly maxBytes: number
  initialize(): Promise<void>
  persist(key: string, bytes: Buffer): Promise<void>
  read(key: string, sha256: string, sizeBytes: number): Promise<Buffer>
}
type Options = {
  access: 'private'
  storeId: string
  abortSignal: AbortSignal
  useCache?: false
  addRandomSuffix?: false
  allowOverwrite?: false
  cacheControlMaxAge?: number
  contentType?: string
}
export interface BlobTransport {
  get(
    pathname: string,
    options: Options,
  ): Promise<{
    statusCode: number
    stream: ReadableStream<Uint8Array> | null
    blob: { url: string; pathname: string; size: number | null }
  } | null>
  put(pathname: string, bytes: Buffer, options: Options): Promise<{ url: string; pathname: string }>
}
const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const marker = Buffer.from('lotos-private-store-v1\n')
const prefix = 'lotos-crm/staging/'
const unavailable = () => new PostgresApiError(503, 'SCHEMA', 'Приватное хранилище документов недоступно')

// A small, injectable transport permits contract tests without cloud tokens.
// No public request can select a transport, store, pathname or remote URL.
export class PrivateBlobStorage implements DocumentStorage {
  readonly maxBytes = VERCEL_RECEIPT_BYTES
  private readonly host: string
  constructor(
    private readonly storeId: string,
    private readonly transport: BlobTransport,
  ) {
    if (!/^store_[a-z0-9]{8,64}$/i.test(storeId)) throw unavailable()
    this.host = storeId.slice(6).toLowerCase() + '.private.blob.vercel-storage.com'
  }
  private objectPath(key: string) {
    if (!/^[a-f0-9]{32}$/.test(key)) throw unavailable()
    return prefix + 'objects/' + key
  }
  private options(): Options {
    return { access: 'private', storeId: this.storeId, abortSignal: AbortSignal.timeout(3_000) }
  }
  private assertIdentity(blob: { url: string; pathname: string }, pathname: string) {
    let url: URL
    try {
      url = new URL(blob.url)
    } catch {
      throw unavailable()
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== this.host ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' + pathname ||
      blob.pathname !== pathname
    )
      throw unavailable()
  }
  private async readPath(pathname: string, sha256: string, size: number): Promise<Buffer | null> {
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isInteger(size) || size <= 0 || size > this.maxBytes)
      throw unavailable()
    const options = { ...this.options(), useCache: false as const }
    const result = await this.transport.get(pathname, options)
    if (result === null) return null // ONLY the SDK's explicit not-found result.
    try {
      this.assertIdentity(result.blob, pathname)
      if (result.statusCode !== 200 || !result.stream || result.blob.size !== size) throw unavailable()
    } catch (error) {
      await result.stream?.cancel().catch(() => undefined)
      throw error
    }
    const reader = result.stream!.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        options.abortSignal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > size) throw unavailable()
        chunks.push(value)
      }
      const bytes = Buffer.concat(chunks, length)
      if (length !== size || checksum(bytes) !== sha256) throw unavailable()
      return bytes
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      reader.releaseLock()
    }
  }
  async read(key: string, sha256: string, size: number) {
    const bytes = await this.readPath(this.objectPath(key), sha256, size)
    if (!bytes) throw unavailable()
    return bytes
  }
  async ready() {
    try {
      return Boolean(await this.readPath(prefix + '_health', checksum(marker), marker.length))
    } catch {
      return false
    }
  }
  async initialize() {
    if (!(await this.ready())) throw unavailable()
  }
  private async persistPath(pathname: string, bytes: Buffer) {
    if (!bytes.length || bytes.length > this.maxBytes) throw unavailable()
    const digest = checksum(bytes)
    if (await this.readPath(pathname, digest, bytes.length)) return
    try {
      const result = await this.transport.put(pathname, bytes, {
        ...this.options(),
        addRandomSuffix: false,
        allowOverwrite: false,
        cacheControlMaxAge: 60,
        contentType: 'application/octet-stream',
      })
      this.assertIdentity(result, pathname)
    } catch (error) {
      // A timeout or concurrent exclusive put may already have committed.
      // Confirm ORIGINAL bytes before returning success; never overwrite/delete.
      if (await this.readPath(pathname, digest, bytes.length)) return
      throw error
    }
    if (!(await this.readPath(pathname, digest, bytes.length))) throw unavailable()
  }
  async persist(key: string, bytes: Buffer) {
    const pathname = this.objectPath(key)
    await this.initialize() // Wrong/public store is rejected before a file write.
    await this.persistPath(pathname, bytes)
  }
  // Operator-only setup: not invoked by readiness, HTTP or the constructor.
  async setup() {
    await this.persistPath(prefix + '_health', marker)
  }
}

export function createBlobStorage(values: NodeJS.ProcessEnv) {
  validateEnvironment(values, 'staging')
  if (
    values.DEPLOY_TARGET !== 'vercel' ||
    values.DOCUMENT_STORAGE !== 'vercel-blob' ||
    values.VERCEL_BLOB_API_URL ||
    values.NEXT_PUBLIC_VERCEL_BLOB_API_URL
  )
    throw unavailable()
  // Let the SDK refresh platform OIDC tokens itself. A static token is used
  // only by explicit out-of-platform operator procedures, never browser code.
  const token = process.env.VERCEL_OIDC_TOKEN ? undefined : values.BLOB_READ_WRITE_TOKEN
  return new PrivateBlobStorage(values.BLOB_STORE_ID!, {
    get: (pathname, options) => get(pathname, { ...options, ...(token ? { token } : {}) }),
    put: (pathname, bytes, options) => put(pathname, bytes, { ...options, ...(token ? { token } : {}) }),
  })
}
