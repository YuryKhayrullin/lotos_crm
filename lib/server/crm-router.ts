import 'server-only'

import { callGas, GasError } from './gas'
import { assertPasswordPolicy, hashPassword } from './passwords'
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

async function prepareCredentialPayload(
  action: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (action === 'createCoach') {
    const username = typeof payload.username === 'string' ? payload.username.trim() : ''
    const password = typeof payload.password === 'string' ? payload.password : ''
    if (Boolean(username) !== Boolean(password))
      throw new GasError('VALIDATION', 400, 'Для создания доступа укажите и логин, и пароль')
    const { password: _password, passwordHash: _passwordHash, ...rest } = payload
    if (!password) return rest
    try {
      assertPasswordPolicy(password)
      return { ...rest, username, passwordHash: await hashPassword(password) }
    } catch (error) {
      throw new GasError('VALIDATION', 400, error instanceof Error ? error.message : 'Некорректный пароль')
    }
  }

  if (action === 'resetCoachPassword') {
    const newPassword = typeof payload.newPassword === 'string' ? payload.newPassword : ''
    const { newPassword: _newPassword, passwordHash: _passwordHash, ...rest } = payload
    try {
      assertPasswordPolicy(newPassword)
      return { ...rest, passwordHash: await hashPassword(newPassword) }
    } catch (error) {
      throw new GasError('VALIDATION', 400, error instanceof Error ? error.message : 'Некорректный пароль')
    }
  }

  return payload
}

function validateBoundaryPayload(action: string, payload: Record<string, unknown>): void {
  if (action !== 'uploadReceipt') return

  const encoded = typeof payload.fileBase64 === 'string' ? payload.fileBase64 : ''
  if (encoded.length > 7 * 1024 * 1024) throw new GasError('PAYLOAD_TOO_LARGE', 413, 'Файл слишком большой')

  const mime = typeof payload.mimeType === 'string' ? payload.mimeType : ''
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(mime)) {
    throw new GasError('UNSUPPORTED_MEDIA_TYPE', 415, 'Разрешены только JPG, PNG и PDF')
  }
}

/**
 * Центральный CRM-router. Все действия из браузера проходят через одну
 * таблицу политики, один branch-scope и один подписанный вызов GAS.
 */
export async function dispatchCrmAction({ action, payload, user }: CrmRouteRequest): Promise<unknown> {
  assertActionAllowed(action, user)
  const credentialSafePayload = await prepareCredentialPayload(action, payload)
  const scopedPayload = withBranchScope(credentialSafePayload, user)
  validateBoundaryPayload(action, scopedPayload)

  return callGas({
    action,
    payload: scopedPayload,
    auth: gasAuth(user),
  })
}
