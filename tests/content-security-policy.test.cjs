const test = require('node:test')
const assert = require('node:assert/strict')
const { contentSecurityPolicy } = require('../.test-dist/server/content-security-policy.js')

const nonce = Buffer.alloc(32, 7).toString('base64')
test('production CSP requires a server nonce and forbids inline scripts, eval and script attributes', () => {
  const value = contentSecurityPolicy(nonce, false, true)
  assert.match(value, new RegExp("script-src 'self' 'nonce-" + nonce + "' 'strict-dynamic'"))
  assert.match(value, /script-src-attr 'none'/)
  assert.match(value, /connect-src 'self';/)
  assert.match(value, /frame-ancestors 'none'/)
  assert.match(value, /upgrade-insecure-requests/)
  const scripts = value.split(';').find((entry) => entry.trim().startsWith('script-src '))
  assert.doesNotMatch(scripts, /unsafe-inline|unsafe-eval|https:|\*/)
})
test('development exceptions never weaken scripts in a production build served over local HTTP', () => {
  assert.match(contentSecurityPolicy(nonce, true, false), /unsafe-eval/)
  assert.match(contentSecurityPolicy(nonce, true, false), /connect-src 'self' ws: wss:/)
  assert.doesNotMatch(contentSecurityPolicy(nonce, false, false), /unsafe-eval|upgrade-insecure-requests/)
})
test('CSP rejects malformed or attacker-controlled nonce values', () => {
  for (const value of ['', 'short', "x'; script-src *", nonce + '\r\nX-Injection: true'])
    assert.throws(() => contentSecurityPolicy(value, false, false))
})
