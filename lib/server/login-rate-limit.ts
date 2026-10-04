import 'server-only'

import { createHash } from 'node:crypto'

const DEFAULT_WINDOW_SECONDS = 15 * 60
const DEFAULT_PAIR_LIMIT = 8
const DEFAULT_IP_LIMIT = 40
const KEY_PREFIX = 'lotos:auth-rate:v1:'

export type RateLimitStore = {
  increment(key: string, windowSeconds: number): Promise<number>
  remove(key: string): Promise<void>
}

export type LoginRateLimitAttempt = {
  pairKey: string
}

type RateLimitConfig = {
  windowSeconds?: number
  pairLimit?: number
  ipLimit?: number
}

export class LoginRateLimitUnavailableError extends Error {
  constructor() {
    super('Хранилище ограничений входа недоступно')
    this.name = 'LoginRateLimitUnavailableError'
  }
}

function keyDigest(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function normalizeIp(value: string): string {
  return value.trim().slice(0, 128) || 'unknown'
}

function normalizeUsername(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU').slice(0, 100)
}

class DevelopmentMemoryRateLimitStore implements RateLimitStore {
  private values = new Map<string, { count: number; expiresAt: number }>()

  async increment(key: string, windowSeconds: number): Promise<number> {
    const now = Date.now()
    const existing = this.values.get(key)
    if (!existing || existing.expiresAt <= now) {
      this.values.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 })
      return 1
    }
    existing.count += 1
    return existing.count
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key)
  }
}

class UpstashRateLimitStore implements RateLimitStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async command(command: Array<string | number>): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
        cache: 'no-store',
      })
    } catch {
      throw new LoginRateLimitUnavailableError()
    }
    if (!response.ok) throw new LoginRateLimitUnavailableError()
    const data = (await response.json().catch(() => null)) as { result?: unknown; error?: unknown } | null
    if (!data || data.error !== undefined) throw new LoginRateLimitUnavailableError()
    return data.result
  }

  async increment(key: string, windowSeconds: number): Promise<number> {
    const created = await this.command(['SET', key, '1', 'NX', 'EX', windowSeconds])
    if (created === 'OK') return 1
    const count = Number(await this.command(['INCR', key]))
    if (!Number.isFinite(count)) throw new LoginRateLimitUnavailableError()
    return count
  }

  async remove(key: string): Promise<void> {
    try {
      await this.command(['DEL', key])
    } catch {
      // A successful authentication remains valid even when its optional
      // pair-counter cleanup cannot be completed.
    }
  }
}

let developmentStore: DevelopmentMemoryRateLimitStore | null = null
let productionStore: UpstashRateLimitStore | null = null

function configuredStore(): RateLimitStore {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) {
    productionStore ??= new UpstashRateLimitStore(url.replace(/\/$/, ''), token)
    return productionStore
  }
  if (process.env.NODE_ENV === 'production') throw new LoginRateLimitUnavailableError()
  developmentStore ??= new DevelopmentMemoryRateLimitStore()
  return developmentStore
}

export function createLoginRateLimiter(store: RateLimitStore, config: RateLimitConfig = {}) {
  const windowSeconds = config.windowSeconds ?? DEFAULT_WINDOW_SECONDS
  const pairLimit = config.pairLimit ?? DEFAULT_PAIR_LIMIT
  const ipLimit = config.ipLimit ?? DEFAULT_IP_LIMIT

  return {
    async check(ip: string, username: string): Promise<LoginRateLimitAttempt | null> {
      const normalizedIp = normalizeIp(ip)
      const normalizedUsername = normalizeUsername(username)
      const pairKey = KEY_PREFIX + 'pair:' + keyDigest(normalizedIp + '\u0000' + normalizedUsername)
      const ipKey = KEY_PREFIX + 'ip:' + keyDigest(normalizedIp)
      const [pairCount, ipCount] = await Promise.all([
        store.increment(pairKey, windowSeconds),
        store.increment(ipKey, windowSeconds),
      ])
      if (pairCount > pairLimit || ipCount > ipLimit) return null
      return { pairKey }
    },
    async resetSuccessfulPair(attempt: LoginRateLimitAttempt): Promise<void> {
      await store.remove(attempt.pairKey)
    },
  }
}

export function getLoginRateLimiter() {
  return createLoginRateLimiter(configuredStore())
}
