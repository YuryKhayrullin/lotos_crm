import 'server-only'

import { createHmac, randomUUID } from 'node:crypto'

const GAS_TIMEOUT_MS = Math.min(Math.max(Number(process.env.GAS_TIMEOUT_MS || 30000), 5000), 60000)
const DEBUG_AUTH = process.env.NODE_ENV !== 'production' || process.env.DEBUG_AUTH === '1'

function debugGas(event: string, details: Record<string, unknown> = {}): void {
  if (DEBUG_AUTH) console.log('[lotos-gas] ' + event, details)
}

export class GasError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message)
    this.name = 'GasError'
  }
}

export type GasRequest = {
  action: string
  payload?: Record<string, unknown>
  auth?: Record<string, unknown>
}

function getGasConfig(): { url: string; secret: string } {
  const url = process.env.GAS_WEBAPP_URL
  const secret = process.env.GAS_API_SECRET
  if (!url || url === 'insert_gas_url_here' || !secret || secret === 'insert_secret_key_here') {
    throw new GasError('API configuration is missing', 503)
  }
  return { url, secret }
}

export async function callGas(request: GasRequest): Promise<unknown> {
  const { url, secret } = getGasConfig()
  debugGas('request.start', { action: request.action, hasAuth: Boolean(request.auth), url: new URL(url).origin })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GAS_TIMEOUT_MS)

  try {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = randomUUID()
    const envelope = {
      action: request.action,
      payload: request.payload ?? {},
      auth: request.auth ?? null,
      timestamp,
      nonce,
    }
    const signedEnvelope = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')
    const signature = createHmac('sha256', secret).update(signedEnvelope).digest('hex')
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ apiKey: secret, signature, signedEnvelope }),
      signal: controller.signal,
    })
    const text = await response.text()
    debugGas('response.received', { action: request.action, httpStatus: response.status, bodyBytes: text.length })
    if (!response.ok || /^\s*</.test(text)) {
      throw new GasError(`GAS returned HTTP ${response.status}`, 502)
    }

    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new GasError('GAS returned invalid JSON', 502)
    }

    if (data && typeof data === 'object' && (data as Record<string, unknown>).status === 'error') {
      const message = String((data as Record<string, unknown>).message || 'GAS request failed')
      const code = String((data as Record<string, unknown>).code || '')
      const build = String((data as Record<string, unknown>).build || '')
      const diagnosticMessage = code ? message + ' [' + code + (build ? '|build:' + build : '') + ']' : message
      debugGas('response.error', { action: request.action, message, code: code || null })
      const status = /unauthorized/i.test(message)
        ? 401
        : /schema is not initialized|deployment|script properties|configuration/i.test(message)
          ? 503
          : 400
      throw new GasError(diagnosticMessage, status)
    }
    return data
  } catch (error) {
    debugGas('request.exception', {
      action: request.action,
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    })
    if (error instanceof GasError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GasError(`GAS timeout after ${Math.round(GAS_TIMEOUT_MS / 1000)}s`, 504)
    }
    throw new GasError('GAS connection failed', 502)
  } finally {
    clearTimeout(timeout)
  }
}
