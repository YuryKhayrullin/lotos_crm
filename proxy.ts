import { randomBytes } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { contentSecurityPolicy } from './lib/server/content-security-policy'

export function proxy(request: NextRequest) {
  const nonce = randomBytes(32).toString('base64')
  const policy = contentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === 'development',
    ['staging', 'production'].includes(process.env.APP_ENV || ''),
  )
  const headers = new Headers(request.headers)
  // Never accept a browser-supplied nonce/policy, including prefetch requests.
  headers.set('x-nonce', nonce)
  headers.set('content-security-policy', policy)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set('content-security-policy', policy)
  response.headers.set('cache-control', 'private, no-store, max-age=0')
  response.headers.set('x-frame-options', 'DENY')
  return response
}

// APIs retain their own authentication, CSRF and no-store contracts. CSP is
// applied to ALL rendered pages, not only visits without prefetch headers.
export const config = {
  matcher: [
    '/((?!api(?:/|$)|_next/static(?:/|$)|_next/image(?:/|$)|favicon\\.ico$|icon\\.svg$|icon-light-32x32\\.png$|apple-icon\\.png$).*)',
  ],
}
