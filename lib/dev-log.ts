type DevLogValue = string | number | boolean | null

/** Browser diagnostics without request bodies, credentials or personal data. */
export function devLog(event: string, details: Record<string, DevLogValue> = {}): void {
  if (process.env.NODE_ENV !== 'production') console.log('[lotos-dev] ' + event, details)
}
