import 'server-only'

const GAS_TIMEOUT_MS = Math.min(Math.max(Number(process.env.GAS_TIMEOUT_MS || 30000), 5000), 60000)

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
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GAS_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        apiKey: secret,
        action: request.action,
        payload: request.payload ?? {},
        auth: request.auth ?? null,
      }),
      signal: controller.signal,
    })
    const text = await response.text()
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
      throw new GasError(message, message === 'Unauthorized' ? 401 : 400)
    }
    return data
  } catch (error) {
    if (error instanceof GasError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GasError(`GAS timeout after ${Math.round(GAS_TIMEOUT_MS / 1000)}s`, 504)
    }
    throw new GasError('GAS connection failed', 502)
  } finally {
    clearTimeout(timeout)
  }
}
