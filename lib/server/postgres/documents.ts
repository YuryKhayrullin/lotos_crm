import 'server-only'
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import sharp from 'sharp'
import { PDFDocument } from 'pdf-lib'
import type { PrismaClient } from '../../../.generated/prisma/client'
import { type Actor, lockActor, requireAdmin } from './access'
import { authDigest } from './accounts'
import { domainMutation } from './mutations'
import { requestKeySchema } from './auth-input'
import { PostgresApiError } from './errors'
import { receiptUploadLimit } from '../../receipt-limits'
import { createBlobStorage, type DocumentStorage } from './blob-storage'

const LIMIT = 5 * 1024 * 1024
const uploadSchema = z
  .object({
    clientId: z.string().min(1).max(100),
    requestId: requestKeySchema,
    expectedReceiptVersion: z.number().int().nonnegative(),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !/[\x00-\x1f\x7f/\\]/.test(value)),
    mimeType: z.enum(['image/png', 'image/jpeg', 'application/pdf']),
    fileBase64: z
      .string()
      .min(4)
      .max(7 * 1024 * 1024),
  })
  .strict()
  .refine(
    (data) =>
      ({ 'image/png': /\.png$/i, 'image/jpeg': /\.(jpg|jpeg)$/i, 'application/pdf': /\.pdf$/i })[data.mimeType].test(
        data.fileName,
      ),
    'Расширение файла должно соответствовать его типу',
  )
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export function documentRoot(values: NodeJS.ProcessEnv) {
  const environment = values.APP_ENV
  const root =
    values.DOCUMENTS_DIR || (environment === 'local' ? path.resolve(process.cwd(), '.private/documents-local') : '')
  const allowed =
    environment === 'local'
      ? root === path.resolve(process.cwd(), '.private/documents-local')
      : environment === 'test'
        ? /^\/tmp\/lotos-crm-documents-test-[A-Za-z0-9_-]+$/.test(root)
        : (environment === 'production' || environment === 'staging') &&
          root === '/var/lib/lotos-crm/documents/' + environment
  if (!allowed) throw new PostgresApiError(503, 'SCHEMA', 'Приватное хранилище документов не настроено')
  return root
}
async function directories(root: string) {
  const folders = [root, path.join(root, 'objects'), path.join(root, 'staging')]
  for (const directory of folders) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(directory)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (await fs.realpath(directory)) !== directory
    )
      throw new PostgresApiError(503, 'SCHEMA', 'Хранилище документов должно быть приватным и без символьных ссылок')
  }
}
async function verifyFile(filename: string, digest: string, size: number) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== size || size > LIMIT || stat.mode & 0o077)
      throw new Error('Private file mismatch')
    const bytes = await handle.readFile()
    if (hash(bytes) !== digest) throw new Error('Private file checksum mismatch')
    return bytes
  } finally {
    await handle.close()
  }
}
async function persistFile(root: string, key: string, bytes: Buffer) {
  if (!/^[a-f0-9]{32}$/.test(key)) throw new PostgresApiError(503, 'SCHEMA', 'Некорректная ссылка хранилища')
  await directories(root)
  const target = path.join(root, 'objects', key),
    digest = hash(bytes)
  try {
    await verifyFile(target, digest, bytes.length)
    return
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const temporary = path.join(root, 'staging', key + '-' + randomUUID() + '.part')
  try {
    const file = await fs.open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    // link is exclusive: unlike rename, it cannot overwrite a confirmed file.
    try {
      await fs.link(temporary, target)
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
      await verifyFile(target, digest, bytes.length)
    }
    const directory = await fs.open(path.dirname(target), constants.O_RDONLY)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await fs.unlink(temporary).catch(() => undefined)
  }
}

export function assertReceiptsEnabled(values: NodeJS.ProcessEnv) {
  if (receiptUploadLimit(values) === 0)
    throw new PostgresApiError(409, 'FEATURE_DISABLED', 'Квитанции отключены на тестовом стенде')
}

function storageFor(values: NodeJS.ProcessEnv, injected?: DocumentStorage): DocumentStorage {
  assertReceiptsEnabled(values)
  if (injected) return injected // Only code-level injection in integration tests.
  if (values.DEPLOY_TARGET === 'vercel') return createBlobStorage(values)
  const root = documentRoot(values)
  return {
    maxBytes: receiptUploadLimit(values),
    initialize: () => directories(root),
    persist: (key, bytes) => persistFile(root, key, bytes),
    read: (key, digest, size) => {
      if (!/^[a-zA-Z0-9_-]{20,100}$/.test(key))
        throw new PostgresApiError(503, 'SCHEMA', 'Некорректная ссылка хранилища')
      return verifyFile(path.join(root, 'objects', key), digest, size)
    },
  }
}

const pdfWorker = `
const {parentPort,workerData}=require('node:worker_threads');
const {PDFDocument,PDFDict,PDFArray,PDFName}=require(workerData.module);
(async()=>{
 const doc=await PDFDocument.load(workerData.bytes,{ignoreEncryption:false,throwOnInvalidObject:true,updateMetadata:false});
 if(doc.isEncrypted || doc.getPageCount()<1 || doc.getPageCount()>100) throw Error('pages');
 const objects=doc.context.enumerateIndirectObjects(); if(objects.length>20000) throw Error('objects');
 const pending=objects.map(pair=>pair[1]),seen=new Set(); let count=0;
 while(pending.length){
   const object=pending.pop();if(seen.has(object))continue;seen.add(object);if(++count>50000)throw Error('complexity');
   if(object instanceof PDFDict){for(const key of object.keys()){
     if(['JavaScript','JS','Launch','EmbeddedFile','EmbeddedFiles','RichMedia','AA','OpenAction'].includes(key.decodeText()))throw Error('active content');
     const value=object.get(key);if(value instanceof PDFName && ['JavaScript','Launch','RichMedia','EmbeddedFile'].includes(value.decodeText()))throw Error('active action');if(value instanceof PDFDict || value instanceof PDFArray)pending.push(value);
   }} else if(object instanceof PDFArray){for(let i=0;i<object.size();i++){const value=object.get(i);if(value instanceof PDFDict || value instanceof PDFArray)pending.push(value)}}
 }
 parentPort.postMessage(true);
})().catch(()=>parentPort.postMessage(false));
`
async function validatePdf(bytes: Buffer) {
  if (typeof PDFDocument.load !== 'function') throw new PostgresApiError(503, 'SCHEMA', 'Проверка PDF недоступна')
  // Native resolution for the isolated worker; static PDFDocument import above
  // keeps this external dependency in Next's server output tracing.
  const nativeRequire = Reflect.apply(createRequire, undefined, [
    path.join(process.cwd(), 'package.json'),
  ]) as ReturnType<typeof createRequire>
  const codecPath = nativeRequire.resolve('pdf-lib')
  const valid = await new Promise<boolean>((resolve) => {
    const worker = new Worker(pdfWorker, {
      eval: true,
      workerData: { bytes, module: codecPath },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
    })
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(result)
    }
    const timer = setTimeout(() => finish(false), 3000)
    worker.once('message', (value) => finish(value === true))
    worker.once('error', () => finish(false))
    worker.once('exit', () => finish(false))
  })
  if (!valid)
    throw new PostgresApiError(
      400,
      'VALIDATION',
      'PDF повреждён, защищён, слишком сложен или содержит активные действия',
    )
}
let decodes = 0
async function validateContent(bytes: Buffer, mime: string) {
  if (decodes >= 2) throw new PostgresApiError(503, 'BUSY', 'Проверка файлов занята. Повторите тот же запрос')
  decodes++
  try {
    if (mime === 'application/pdf') {
      if (
        !/^%PDF-(1\.[0-7]|2\.0)/.test(bytes.subarray(0, 16).toString('ascii')) ||
        !/%%EOF\s*$/.test(bytes.subarray(-2048).toString('latin1'))
      )
        throw new PostgresApiError(400, 'VALIDATION', 'Содержимое не соответствует PDF')
      await validatePdf(bytes)
    } else {
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      if ((mime === 'image/png' && !png) || (mime === 'image/jpeg' && !jpg))
        throw new PostgresApiError(400, 'VALIDATION', 'Содержимое не соответствует типу изображения')
      try {
        const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 25_000_000 })
        const metadata = await image.metadata()
        if (
          (mime === 'image/png' && metadata.format !== 'png') ||
          (mime === 'image/jpeg' && metadata.format !== 'jpeg') ||
          (metadata.pages || 1) !== 1
        )
          throw Error('format')
        await image.timeout({ seconds: 3 }).raw().toBuffer() // decode, retain ORIGINAL evidence bytes
      } catch {
        throw new PostgresApiError(400, 'VALIDATION', 'Изображение повреждено или превышает допустимую сложность')
      }
    }
  } finally {
    decodes--
  }
}
export async function uploadReceipt(
  db: PrismaClient,
  actor: Actor,
  input: unknown,
  values: NodeJS.ProcessEnv,
  injectedStorage?: DocumentStorage,
) {
  requireAdmin(actor)
  assertReceiptsEnabled(values)
  const data = uploadSchema.parse(input),
    storage = storageFor(values, injectedStorage)
  const encoded = data.fileBase64
  // Linear scan, not a repeated-group regexp that can exhaust V8's regexp
  // stack on a valid multi-megabyte file.
  let validBase64 = encoded.length % 4 === 0
  for (let index = 0; index < encoded.length && validBase64; index++) {
    const code = encoded.charCodeAt(index)
    if (code === 61) {
      validBase64 = index >= encoded.length - 2 && (index === encoded.length - 1 || encoded[index + 1] === '=')
    } else
      validBase64 =
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
  }
  if (!validBase64) throw new PostgresApiError(400, 'VALIDATION', 'Некорректное содержимое файла')
  const bytes = Buffer.from(data.fileBase64, 'base64')
  if (bytes.toString('base64') !== encoded)
    throw new PostgresApiError(400, 'VALIDATION', 'Неканоническое содержимое файла')
  if (!bytes.length || bytes.length > storage.maxBytes)
    throw new PostgresApiError(
      413,
      'PAYLOAD_TOO_LARGE',
      'Квитанция должна быть не более ' + storage.maxBytes / (1024 * 1024) + ' МиБ',
    )
  const payload = {
    clientId: data.clientId,
    expectedReceiptVersion: data.expectedReceiptVersion,
    fileName: data.fileName,
    mimeType: data.mimeType,
    sha256: hash(bytes),
    sizeBytes: bytes.length,
  }
  const fingerprint = authDigest(values.BETTER_AUTH_SECRET!, 'domain-mutation', { action: 'uploadReceipt', payload })
  const where = { actorId_requestKey: { actorId: actor.id, requestKey: data.requestId } }
  const intent = await db.$transaction(async (tx) => {
    // Serialize pending-capacity checks across distinct upload keys as well.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id + ':document-intents'},0))`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id + ':' + data.requestId},0))`
    const canonical = await lockActor(tx, actor)
    requireAdmin(canonical)
    const previous = await tx.mutationRequest.findUnique({ where })
    if (previous && (previous.action !== 'uploadReceipt' || previous.fingerprint !== fingerprint))
      throw new PostgresApiError(409, 'CONFLICT', 'Этот requestId уже использован с другими данными')
    const prepared = await tx.documentUpload.findUnique({ where })
    if (prepared) {
      if (prepared.fingerprint !== fingerprint || prepared.clientId !== data.clientId)
        throw new PostgresApiError(409, 'CONFLICT', 'Этот requestId уже использован с другими данными')
      if (prepared.state === 'abandoned')
        throw new PostgresApiError(409, 'CONFLICT', 'Попытка закрыта вручную. Начните новую загрузку.')
      return prepared
    }
    const client = await tx.client.findUnique({ where: { id: data.clientId } })
    if (!client) throw new PostgresApiError(404, 'NOT_FOUND', 'Клиент не найден')
    if (client.receiptVersion !== data.expectedReceiptVersion)
      throw new PostgresApiError(409, 'CONFLICT', 'Квитанция изменилась. Обновите карточку.')
    if ((await tx.documentUpload.count({ where: { actorId: actor.id, state: 'pending' } })) >= 20)
      throw new PostgresApiError(409, 'CONFLICT', 'Сначала разрешите незавершённые загрузки документов')
    return tx.documentUpload.create({
      data: {
        actorId: actor.id,
        clientId: client.id,
        requestKey: data.requestId,
        fingerprint,
        payload,
        storageKey: randomUUID().replaceAll('-', ''),
      },
    })
  })
  if (intent.state !== 'attached') {
    try {
      await validateContent(bytes, data.mimeType)
    } catch (error) {
      // Definitive invalid content has never reached persistFile(). Do not
      // exhaust pending capacity with rejected files. BUSY/unknown stays retryable.
      if (error instanceof PostgresApiError && error.status === 400)
        await db.documentUpload.deleteMany({ where: { id: intent.id, state: 'pending' } }).catch(() => undefined)
      throw error
    }
  }
  return domainMutation(
    db,
    actor,
    'uploadReceipt',
    data.requestId,
    payload,
    values.BETTER_AUTH_SECRET!,
    async (tx, canonical, requestId) => {
      requireAdmin(canonical)
      const latestIntent = await tx.documentUpload.findUniqueOrThrow({ where: { id: intent.id } })
      if (latestIntent.state !== 'pending')
        throw new PostgresApiError(409, 'CONFLICT', 'Попытка больше не ожидает сохранения. Обновите карточку.')
      await tx.$queryRaw`SELECT id FROM clients WHERE id=${data.clientId} FOR UPDATE`
      const client = await tx.client.findUniqueOrThrow({ where: { id: data.clientId } })
      if (client.receiptVersion !== data.expectedReceiptVersion)
        throw new PostgresApiError(409, 'CONFLICT', 'Квитанция изменилась. Обновите карточку.')
      // File is durable before a SQL reference can become visible. On an unknown
      // SQL outcome NEVER delete it: retry resolves the marker/intent safely.
      await storage.persist(intent.storageKey, bytes)
      await tx.document.updateMany({
        where: { clientId: client.id, supersededAt: null },
        data: { supersededAt: new Date() },
      })
      const document = await tx.document.create({
        data: {
          clientId: client.id,
          branchId: client.branchId,
          uploadedById: canonical.id,
          requestId,
          storageKey: intent.storageKey,
          originalName: data.fileName,
          mimeType: data.mimeType,
          sizeBytes: BigInt(bytes.length),
          sha256: payload.sha256,
        },
      })
      await tx.client.update({
        where: { id: client.id },
        data: { receiptDocumentId: document.id, receiptVersion: { increment: 1 }, version: { increment: 1 } },
      })
      await tx.documentUpload.update({ where: { id: intent.id }, data: { state: 'attached' } })
      await tx.auditEvent.create({
        data: {
          actorId: canonical.id,
          requestId,
          action: 'uploadReceipt',
          entityType: 'client',
          entityId: client.id,
          branchId: client.branchId,
          changedFields: ['receiptDocumentId', 'receiptVersion'],
        },
      })
      return {
        success: true,
        receiptVersion: client.receiptVersion + 1,
        receiptUrl: '/api/receipts/' + encodeURIComponent(client.id),
      }
    },
    async (tx, _result, canonical) => {
      requireAdmin(canonical)
      const client = await tx.client.findUniqueOrThrow({ where: { id: data.clientId } })
      return {
        success: true,
        duplicate: true,
        receiptVersion: client.receiptVersion,
        receiptUrl: '/api/receipts/' + encodeURIComponent(client.id),
      }
    },
    { timeout: 20_000 },
  )
}
const recoveryPayload = z
  .object({
    clientId: z.string().min(1).max(100),
    expectedReceiptVersion: z.number().int().nonnegative(),
    fileName: z.string().min(1).max(200),
    mimeType: z.enum(['image/png', 'image/jpeg', 'application/pdf']),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().positive().max(LIMIT),
  })
  .strict()
export async function receiptAttempts(
  db: PrismaClient,
  actor: Actor,
  clientId: string,
  values: NodeJS.ProcessEnv,
  injectedStorage?: DocumentStorage,
) {
  requireAdmin(actor)
  const storage = storageFor(values, injectedStorage)
  const rows = await db.documentUpload.findMany({
    where: { actorId: actor.id, clientId, state: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })
  return {
    attempts: await Promise.all(
      rows.map(async (row) => {
        const parsed = recoveryPayload.safeParse(row.payload)
        let resumable = false
        if (parsed.success) {
          try {
            await storage.initialize()
            await storage.read(row.storageKey, parsed.data.sha256, parsed.data.sizeBytes)
            resumable = true
          } catch {}
        }
        return {
          requestId: row.requestKey,
          metadata: parsed.success ? parsed.data : null,
          resumable,
          createdAt: row.createdAt.toISOString(),
        }
      }),
    ),
  }
}
export async function resumeReceipt(
  db: PrismaClient,
  actor: Actor,
  clientId: string,
  input: unknown,
  values: NodeJS.ProcessEnv,
  injectedStorage?: DocumentStorage,
) {
  requireAdmin(actor)
  assertReceiptsEnabled(values)
  const data = z.object({ requestId: requestKeySchema }).strict().parse(input)
  const row = await db.documentUpload.findUnique({
    where: { actorId_requestKey: { actorId: actor.id, requestKey: data.requestId } },
  })
  if (!row || row.clientId !== clientId) throw new PostgresApiError(404, 'NOT_FOUND', 'Попытка не найдена')
  const payload = recoveryPayload.safeParse(row.payload)
  if (!payload.success || payload.data.clientId !== clientId)
    throw new PostgresApiError(409, 'CONFLICT', 'Для старой попытки нужен исходный файл и проверка оператора')
  const storage = storageFor(values, injectedStorage)
  await storage.initialize()
  let bytes: Buffer
  try {
    bytes = await storage.read(row.storageKey, payload.data.sha256, payload.data.sizeBytes)
  } catch {
    throw new PostgresApiError(409, 'CONFLICT', 'Исходный файл попытки отсутствует или повреждён. Требуется сверка.')
  }
  const metadata = {
    clientId: payload.data.clientId,
    expectedReceiptVersion: payload.data.expectedReceiptVersion,
    fileName: payload.data.fileName,
    mimeType: payload.data.mimeType,
  }
  return uploadReceipt(
    db,
    actor,
    { ...metadata, requestId: data.requestId, fileBase64: bytes.toString('base64') },
    values,
    injectedStorage,
  )
}
export async function closeReceiptAttempt(db: PrismaClient, actor: Actor, clientId: string, requestId: string) {
  requestKeySchema.parse(requestId)
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id + ':' + requestId},0))`
    const canonical = await lockActor(tx, actor)
    requireAdmin(canonical)
    const where = { actorId_requestKey: { actorId: canonical.id, requestKey: requestId } }
    const row = await tx.documentUpload.findUnique({ where })
    if (!row || row.clientId !== clientId) throw new PostgresApiError(404, 'NOT_FOUND', 'Попытка не найдена')
    const marker = await tx.mutationRequest.findUnique({ where })
    if (marker) return { success: true, alreadyConfirmed: true }
    if (row.state === 'pending') {
      await tx.documentUpload.update({ where: { id: row.id }, data: { state: 'abandoned' } })
      await tx.auditEvent.create({
        data: {
          actorId: canonical.id,
          action: 'closeReceiptAttempt',
          entityType: 'client',
          entityId: clientId,
          changedFields: ['documentUploadState'],
          reason: 'Пользователь явно закрыл неподтверждённую загрузку; файлы не удалялись',
        },
      })
    }
    return { success: true, alreadyConfirmed: false }
  })
}
export async function readReceipt(
  db: PrismaClient,
  actor: Actor,
  clientId: string,
  values: NodeJS.ProcessEnv,
  injectedStorage?: DocumentStorage,
) {
  requireAdmin(actor)
  assertReceiptsEnabled(values)
  const client = await db.client.findUnique({ where: { id: clientId }, include: { currentReceipt: true } }),
    document = client?.currentReceipt
  if (!client) throw new PostgresApiError(404, 'NOT_FOUND', 'Клиент не найден')
  if (!document) throw new PostgresApiError(404, 'NOT_FOUND', 'Квитанция не найдена')
  const storage = storageFor(values, injectedStorage)
  await storage.initialize()
  if (!/^[a-zA-Z0-9_-]{20,100}$/.test(document.storageKey))
    throw new PostgresApiError(503, 'SCHEMA', 'Некорректная ссылка хранилища')
  let bytes: Buffer
  try {
    bytes = await storage.read(document.storageKey, document.sha256, Number(document.sizeBytes))
  } catch {
    throw new PostgresApiError(503, 'SERVICE_UNAVAILABLE', 'Файл квитанции недоступен или требует проверки')
  }
  return { bytes, document }
}
export async function receiptResponse(
  db: PrismaClient,
  actor: Actor,
  clientId: string,
  values: NodeJS.ProcessEnv,
  injectedStorage?: DocumentStorage,
) {
  const { bytes, document } = await readReceipt(db, actor, clientId, values, injectedStorage)
  const extension =
    { 'image/png': '.png', 'image/jpeg': '.jpg', 'application/pdf': '.pdf' }[document.mimeType] || '.bin'
  const downloadName =
    document.originalName.toLowerCase().endsWith(extension) ||
    (document.mimeType === 'image/jpeg' && /\.jpeg$/i.test(document.originalName))
      ? document.originalName
      : document.originalName + extension
  const encoded = encodeURIComponent(downloadName).replace(
    /[!'()*]/g,
    (value) => '%' + value.charCodeAt(0).toString(16),
  )
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': document.mimeType,
      'content-length': String(bytes.length),
      'content-disposition': `attachment; filename="receipt"; filename*=UTF-8''${encoded}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  })
}
export async function inspectDocumentUploads(db: PrismaClient, values: NodeJS.ProcessEnv) {
  const root = documentRoot(values)
  const intents = await db.documentUpload.findMany({
    where: { state: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })
  return {
    pending: await db.documentUpload.count({ where: { state: 'pending' } }),
    returned: intents.length,
    uploads: await Promise.all(
      intents.map(async (intent) => ({
        id: intent.id,
        clientId: intent.clientId,
        createdAt: intent.createdAt.toISOString(),
        filePresent: await fs
          .lstat(path.join(root, 'objects', intent.storageKey))
          .then((stat) => stat.isFile() && !stat.isSymbolicLink())
          .catch(() => false),
        // Informational only. No automatic deletion of uncertain or historical files.
        olderThan24h: intent.createdAt.getTime() < Date.now() - 86_400_000,
      })),
    ),
  }
}
