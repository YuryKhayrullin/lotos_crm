import { createHash } from 'node:crypto'
import type { SessionUser } from './session'

export const CACHEABLE_CRM_READ_ACTIONS = new Set([
  'getBootstrapData',
  'getSheet',
  'getClients',
  'getDashboardSummary',
  'getFinanceSummary',
  'getSubscriptionsPage',
  'searchClientOptions',
  'getLessonRoster',
])

export const MUTATING_CRM_ACTIONS = new Set([
  'assignUserBranch',
  'deactivateUser',
  'activateUser',
  'resetCoachPassword',
  'linkCoachUser',
  'createClient',
  'createLesson',
  'createBranch',
  'createCoach',
  'updateClient',
  'updateLesson',
  'deleteClient',
  'deleteCoach',
  'deleteLesson',
  'assignClientLesson',
  'recordAttendance',
  'recordBulkAttendance',
  'recordPayment',
  'recordAdjustment',
  'repairLessonLedger',
  'uploadReceipt',
])

export type CrmReadCacheStatus = 'MISS' | 'COALESCED' | 'HIT' | 'STALE'

type CacheEntry = {
  value: unknown
  updatedAt: number
}

type CacheOptions = {
  freshMs?: number
  staleMs?: number
  maxEntries?: number
  now?: () => number
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function createCrmReadCache(options: CacheOptions = {}) {
  const freshMs = options.freshMs ?? 60_000
  const staleMs = Math.max(options.staleMs ?? 10 * 60_000, freshMs)
  const maxEntries = options.maxEntries ?? 250
  const now = options.now ?? Date.now
  const entries = new Map<string, CacheEntry>()
  const inFlight = new Map<string, Promise<unknown>>()
  let generation = 0

  function keyFor(action: string, payload: Record<string, unknown>, user: SessionUser): string {
    const source = stableJson({
      action,
      payload,
      user: { id: user.id, role: user.role, branchId: user.branchId },
    })
    return createHash('sha256').update(source).digest('hex')
  }

  function store(key: string, value: unknown, loadGeneration: number): unknown {
    if (loadGeneration !== generation) return value
    entries.delete(key)
    entries.set(key, { value, updatedAt: now() })
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value
      if (oldestKey === undefined) break
      entries.delete(oldestKey)
    }
    return value
  }

  function load(key: string, loader: () => Promise<unknown>): { promise: Promise<unknown>; coalesced: boolean } {
    const current = inFlight.get(key)
    if (current) return { promise: current, coalesced: true }

    const loadGeneration = generation
    const promise = loader()
      .then((value) => store(key, value, loadGeneration))
      .finally(() => {
        if (inFlight.get(key) === promise) inFlight.delete(key)
      })
    inFlight.set(key, promise)
    return { promise, coalesced: false }
  }

  return {
    async getOrLoad(
      action: string,
      payload: Record<string, unknown>,
      user: SessionUser,
      loader: () => Promise<unknown>,
    ): Promise<{ value: unknown; status: CrmReadCacheStatus }> {
      const key = keyFor(action, payload, user)
      const entry = entries.get(key)
      if (entry) {
        const age = now() - entry.updatedAt
        if (age <= freshMs) return { value: entry.value, status: 'HIT' }
        if (age <= staleMs) {
          // Return known-good private data immediately. The refresh is
          // intentionally detached so GAS cold starts do not block the UI.
          void load(key, loader).promise.catch(() => undefined)
          return { value: entry.value, status: 'STALE' }
        }
        entries.delete(key)
      }

      const pending = load(key, loader)
      return {
        value: await pending.promise,
        status: pending.coalesced ? 'COALESCED' : 'MISS',
      }
    },

    invalidate(): void {
      generation += 1
      entries.clear()
    },

    size(): number {
      return entries.size
    },
  }
}

type CrmReadCache = ReturnType<typeof createCrmReadCache>
const cacheGlobal = globalThis as typeof globalThis & { __lotosCrmReadCache?: CrmReadCache }

export const crmReadCache =
  cacheGlobal.__lotosCrmReadCache ??
  createCrmReadCache({
    freshMs: positiveInteger(process.env.CRM_READ_CACHE_FRESH_MS, 60_000),
    staleMs: positiveInteger(process.env.CRM_READ_CACHE_STALE_MS, 10 * 60_000),
    maxEntries: positiveInteger(process.env.CRM_READ_CACHE_MAX_ENTRIES, 250),
  })

cacheGlobal.__lotosCrmReadCache = crmReadCache
