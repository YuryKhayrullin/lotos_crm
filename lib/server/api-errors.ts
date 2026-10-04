export const GAS_ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'BUSY',
  'SCHEMA',
] as const

export type GasErrorCode = (typeof GAS_ERROR_CODES)[number]

export type PublicApiErrorCode =
  | GasErrorCode
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'METHOD_NOT_ALLOWED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL'

const GAS_ERROR_CODE_SET = new Set<string>(GAS_ERROR_CODES)

const GAS_ERROR_STATUSES: Record<GasErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BUSY: 503,
  SCHEMA: 503,
}

const GAS_ERROR_MESSAGES: Record<GasErrorCode, string> = {
  UNAUTHORIZED: 'Требуется авторизация',
  FORBIDDEN: 'Недостаточно прав для этого действия',
  VALIDATION: 'Проверьте введённые данные',
  NOT_FOUND: 'Объект не найден',
  CONFLICT: 'Данные изменились или запрос конфликтует с уже выполненной операцией',
  BUSY: 'Система занята. Повторите попытку',
  SCHEMA: 'Сервис данных временно недоступен',
}

export function isGasErrorCode(value: unknown): value is GasErrorCode {
  return typeof value === 'string' && GAS_ERROR_CODE_SET.has(value)
}

export function statusForGasErrorCode(code: GasErrorCode): number {
  return GAS_ERROR_STATUSES[code]
}

export function messageForGasErrorCode(code: GasErrorCode): string {
  return GAS_ERROR_MESSAGES[code]
}

export function codeForHttpStatus(status: number): PublicApiErrorCode {
  if (status === 401) return 'UNAUTHORIZED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 413) return 'PAYLOAD_TOO_LARGE'
  if (status === 415) return 'UNSUPPORTED_MEDIA_TYPE'
  if (status === 503 || status === 502 || status === 504) return 'SERVICE_UNAVAILABLE'
  return status >= 500 ? 'INTERNAL' : 'VALIDATION'
}
