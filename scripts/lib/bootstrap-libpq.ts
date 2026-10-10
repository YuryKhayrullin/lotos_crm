import { hashPassword } from 'better-auth/crypto'
import { buildBootstrapSql, bootstrapPreflightSql } from './bootstrap-sql'
import { runBootstrapPsql, BootstrapTransportError } from './bootstrap-psql.mjs'
import { bootstrapAdminSchema } from '../../lib/server/postgres/auth-input'
import { PostgresApiError } from '../../lib/server/postgres/errors'

export function checkBootstrapLibpq(values: NodeJS.ProcessEnv) {
  const output = runBootstrapPsql(values, bootstrapPreflightSql, { readOnly: true })
  let result
  try {
    result = JSON.parse(output.trim())
  } catch {
    throw new BootstrapTransportError('PSQL_FAILED')
  }
  if (
    result.role !== 'lotos_runtime' ||
    result.database !== 'postgres' ||
    !Number.isInteger(result.admins) ||
    result.admins < 0 ||
    typeof result.authLockAvailable !== 'boolean'
  )
    throw new BootstrapTransportError('IDENTITY_MISMATCH')
  return result as { role: string; database: string; admins: number; authLockAvailable: boolean }
}

export async function bootstrapAdminLibpq(values: NodeJS.ProcessEnv, input: unknown) {
  const data = bootstrapAdminSchema.parse(input)
  const { sql, user } = buildBootstrapSql(data, await hashPassword(data.password))
  const output = runBootstrapPsql(values, sql)
  if (!output.trim().split(/\r?\n/).includes('LOTOS_BOOTSTRAP_COMMITTED'))
    throw new BootstrapTransportError('COMMIT_UNKNOWN')
  return user
}

export function requireBootstrapOpen(result: ReturnType<typeof checkBootstrapLibpq>) {
  if (result.admins) throw new PostgresApiError(409, 'CONFLICT', 'Первый администратор уже существует')
  if (!result.authLockAvailable) throw new BootstrapTransportError('LOCK_BUSY')
}
