import 'server-only'

import { callGas, GasError } from './gas'
import { assertActionAllowed, withBranchScope } from './policy'
import type { SessionUser } from './session'

export const UPLOAD_ACTIONS = new Set(['uploadReceipt'])

export type CrmRouteRequest = {
  action: string
  payload: Record<string, unknown>
  user: SessionUser
}

function gasAuth(user: SessionUser): Record<string, unknown> {
  return { id: user.id, username: user.username, role: user.role, branchId: user.branchId }
}

function validateBoundaryPayload(action: string, payload: Record<string, unknown>): void {
  if (action !== 'uploadReceipt') return

  const encoded = typeof payload.fileBase64 === 'string' ? payload.fileBase64 : ''
  if (encoded.length > 7 * 1024 * 1024) throw new GasError('Файл слишком большой', 413)

  const mime = typeof payload.mimeType === 'string' ? payload.mimeType : ''
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(mime)) {
    throw new GasError('Разрешены только JPG, PNG и PDF', 415)
  }
}

/**
 * Центральный CRM-router. Все действия из браузера проходят через одну
 * таблицу политики, один branch-scope и один подписанный вызов GAS.
 */
export async function dispatchCrmAction({ action, payload, user }: CrmRouteRequest): Promise<unknown> {
  assertActionAllowed(action, user)
  const scopedPayload = withBranchScope(payload, user)
  validateBoundaryPayload(action, scopedPayload)

  return callGas({
    action,
    payload: scopedPayload,
    auth: gasAuth(user),
  })
}
