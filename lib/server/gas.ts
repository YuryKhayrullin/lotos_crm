import 'server-only'

import { createHmac, randomUUID } from 'node:crypto'
import {
  codeForHttpStatus,
  isGasErrorCode,
  messageForGasErrorCode,
  statusForGasErrorCode,
  type PublicApiErrorCode,
} from './api-errors'
import { serverLog } from './logger'

const GAS_TIMEOUT_MS = Math.min(Math.max(Number(process.env.GAS_TIMEOUT_MS || 30000), 5000), 60000)

export class GasError extends Error {
  constructor(
    public readonly code: PublicApiErrorCode,
    public readonly status: number,
    public readonly publicMessage: string,
    public readonly upstreamStatus: number | null = null,
  ) {
    super(publicMessage)
    this.name = 'GasError'
  }
}

export type GasRequest = {
  action: string
  payload?: Record<string, unknown>
  auth?: Record<string, unknown>
}

function getGasConfig(): { url: string; hmacSecret: string } {
  const url = process.env.GAS_WEBAPP_URL
  const hmacSecret = process.env.GAS_HMAC_SECRET
  if (
    !url ||
    url === 'insert_gas_url_here' ||
    !hmacSecret ||
    hmacSecret.length < 32 ||
    hmacSecret === 'insert_secret_key_here'
  ) {
    throw new GasError('SERVICE_UNAVAILABLE', 503, 'Сервис данных временно недоступен')
  }
  return { url, hmacSecret }
}

export async function callGas(request: GasRequest): Promise<unknown> {
  const startedAt = performance.now()
  let succeeded = false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GAS_TIMEOUT_MS)

  try {
    const { url, hmacSecret } = getGasConfig()
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = randomUUID()
    const envelope = {
      action: request.action,
      payload: request.payload ?? {},
      auth: request.auth ?? null,
      timestamp,
      nonce,
      diagnostics: process.env.NODE_ENV === 'development',
    }
    const signedEnvelope = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')
    const signature = createHmac('sha256', hmacSecret).update(signedEnvelope).digest('hex')
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ signature, signedEnvelope }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok || /^\s*</.test(text)) {
      throw new GasError('SERVICE_UNAVAILABLE', 503, 'Сервис данных временно недоступен', response.status)
    }

    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new GasError('SERVICE_UNAVAILABLE', 503, 'Сервис данных временно недоступен', response.status)
    }

    if (data && typeof data === 'object' && (data as Record<string, unknown>).gasDiagnosticsVersion === 1) {
      const diagnostic = data as Record<string, unknown>
      if (process.env.NODE_ENV === 'development') {
        const processingMs = diagnostic.processingMs
        if (typeof processingMs === 'number' && Number.isFinite(processingMs) && processingMs >= 0)
          serverLog('info', 'gas.processing', { action: request.action, durationMs: processingMs })
        if (Array.isArray(diagnostic.timings)) {
          for (const timing of diagnostic.timings.slice(0, 30)) {
            if (!timing || typeof timing !== 'object') continue
            const { stage, durationMs } = timing
            if (
              typeof stage === 'string' &&
              /^[a-z._]{1,80}$/.test(stage) &&
              typeof durationMs === 'number' &&
              Number.isFinite(durationMs) &&
              durationMs >= 0
            )
              serverLog('info', 'gas.stage', { action: request.action, stage, durationMs })
          }
        }
      }
      // Operational diagnostics stay on the server, never in browser responses.
      data = diagnostic.response
    }

    if (data && typeof data === 'object' && (data as Record<string, unknown>).status === 'error') {
      const rawCode = (data as Record<string, unknown>).code
      if (!isGasErrorCode(rawCode)) {
        throw new GasError('SERVICE_UNAVAILABLE', 503, 'Сервис данных временно недоступен', response.status)
      }
      throw new GasError(rawCode, statusForGasErrorCode(rawCode), messageForGasErrorCode(rawCode), response.status)
    }
    succeeded = true
    return data
  } catch (error) {
    if (error instanceof GasError) {
      serverLog('warn', 'gas.request.failed', {
        action: request.action,
        code: error.code,
        status: error.status,
        upstreamStatus: error.upstreamStatus,
      })
      throw error
    }
    if (error instanceof Error && error.name === 'AbortError') {
      const timeoutError = new GasError('SERVICE_UNAVAILABLE', 503, 'Сервис данных временно недоступен')
      serverLog('warn', 'gas.request.failed', {
        action: request.action,
        code: timeoutError.code,
        status: timeoutError.status,
        reason: 'timeout',
      })
      throw timeoutError
    }
    const connectionError = new GasError(codeForHttpStatus(503), 503, 'Сервис данных временно недоступен')
    serverLog('warn', 'gas.request.failed', {
      action: request.action,
      code: connectionError.code,
      status: connectionError.status,
      reason: 'connection',
    })
    throw connectionError
  } finally {
    clearTimeout(timeout)
    serverLog('info', 'gas.request.completed', {
      action: request.action,
      success: succeeded,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    })
  }
}
