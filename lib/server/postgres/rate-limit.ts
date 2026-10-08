import 'server-only'
import { isIP } from 'node:net'
import type { PrismaClient } from '../../../.generated/prisma/client'
import { authDigest } from './accounts'
import { PostgresApiError } from './errors'

export function trustedClientIp(headers: Headers, values: NodeJS.ProcessEnv) {
  // Next has no trustworthy socket address. Only a configured, private Caddy
  // upstream may set this dedicated, overwritten header; never trust raw XFF.
  if (values.TRUSTED_PROXY === 'caddy') {
    const candidate = headers.get('x-lotos-client-ip') || ''
    if (isIP(candidate)) return candidate
  }
  return 'unknown'
}

export async function incrementAuthBucket(db: PrismaClient, key: string) {
  const rows = await db.$queryRaw<Array<{ hits: number }>>`
    INSERT INTO auth_rate_buckets (key, hits, expires_at) VALUES (${key}, 1, now() + interval '15 minutes')
    ON CONFLICT (key) DO UPDATE SET
      hits = CASE WHEN auth_rate_buckets.expires_at <= now() THEN 1 ELSE LEAST(auth_rate_buckets.hits + 1, 1000000) END,
      expires_at = CASE WHEN auth_rate_buckets.expires_at <= now() THEN now() + interval '15 minutes' ELSE auth_rate_buckets.expires_at END
    RETURNING hits`
  return rows[0].hits
}

export async function checkAuthRate(
  db: PrismaClient,
  values: NodeJS.ProcessEnv,
  headers: Headers,
  username: string,
  purpose: 'login' | 'registration',
) {
  const secret = values.BETTER_AUTH_SECRET!
  const ip = trustedClientIp(headers, values)
  // The global IP budget is checked BEFORE creating arbitrary username keys.
  const ipCount = await incrementAuthBucket(db, authDigest(secret, 'auth-ip', [purpose, ip]))
  if (ipCount > (purpose === 'login' ? 40 : 10))
    throw new PostgresApiError(429, 'RATE_LIMITED', 'Слишком много попыток. Повторите через 15 минут')
  const pairCount = await incrementAuthBucket(db, authDigest(secret, 'auth-pair', [purpose, ip, username]))
  if (pairCount > (purpose === 'login' ? 8 : 3))
    throw new PostgresApiError(429, 'RATE_LIMITED', 'Слишком много попыток. Повторите через 15 минут')
  await db.authRateBucket.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } } })
}
