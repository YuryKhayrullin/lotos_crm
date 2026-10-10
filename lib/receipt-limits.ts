export const FILESYSTEM_RECEIPT_BYTES = 5 * 1024 * 1024
export const VERCEL_RECEIPT_BYTES = 3 * 1024 * 1024
export function receiptUploadLimit(values: NodeJS.ProcessEnv) {
  if (values.DEPLOY_TARGET === 'vercel' && values.DOCUMENT_STORAGE === 'disabled') return 0
  return values.DEPLOY_TARGET === 'vercel' ? VERCEL_RECEIPT_BYTES : FILESYSTEM_RECEIPT_BYTES
}
