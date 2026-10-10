// Pure policy builder. Nonces are generated only on the server, per request.
export function contentSecurityPolicy(nonce: string, development: boolean, https: boolean) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(nonce)) throw new Error('Invalid CSP nonce')
  return (
    [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
      "script-src-attr 'none'",
      // Base UI positioning and existing React style attributes require inline
      // styles. This does NOT grant inline script or event-handler execution.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "font-src 'self'",
      `connect-src 'self'${development ? ' ws: wss:' : ''}`,
      "worker-src 'self' blob:",
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      ...(https ? ['upgrade-insecure-requests'] : []),
    ].join('; ') + ';'
  )
}
