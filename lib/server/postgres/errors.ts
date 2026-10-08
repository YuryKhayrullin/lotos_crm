import 'server-only'
import { ZodError } from 'zod'

export class PostgresApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PostgresApiError'
  }
}

export function publicPostgresError(error: unknown) {
  if (error instanceof PostgresApiError) return error
  if (error instanceof ZodError) return new PostgresApiError(400, 'VALIDATION', 'Проверьте введённые данные')
  // Do not derive permissions/errors from database error text or log SQL/args.
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'P2002') return new PostgresApiError(409, 'CONFLICT', 'Данные конфликтуют с существующей записью')
  if (code === 'P2003') return new PostgresApiError(409, 'CONFLICT', 'Связанные данные изменились')
  if (code === 'P2025') return new PostgresApiError(404, 'NOT_FOUND', 'Объект не найден')
  if (code === 'P2034') return new PostgresApiError(503, 'BUSY', 'Система занята. Повторите тот же запрос')
  return new PostgresApiError(503, 'SERVICE_UNAVAILABLE', 'Сервис временно недоступен')
}
