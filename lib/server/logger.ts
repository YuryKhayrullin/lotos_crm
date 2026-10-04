import 'server-only'

type LogLevel = 'info' | 'warn' | 'error'
type LogValue = string | number | boolean | null

/**
 * Server-only structured logging. Callers must pass operational metadata only:
 * no request bodies, credentials, IP addresses, identifiers or personal data.
 */
export function serverLog(level: LogLevel, event: string, details: Record<string, LogValue> = {}): void {
  const entry = JSON.stringify({ service: 'lotos-bff', level, event, ...details })
  if (level === 'error') console.error(entry)
  else if (level === 'warn') console.warn(entry)
  else console.info(entry)
}
