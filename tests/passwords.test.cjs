const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function loadServerModule(relativePath) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const exports = {}
  const context = {
    exports,
    Buffer,
    process,
    require: (name) => (name === 'server-only' ? {} : require(name)),
  }
  vm.createContext(context)
  vm.runInContext(compiled, context)
  return exports
}

const passwords = loadServerModule('lib/server/passwords.ts')

test('scrypt hashes verify only the original password and reject legacy formats', async () => {
  const hash = await passwords.hashPassword('secure-password')
  assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/)
  assert.equal(await passwords.verifyPassword('secure-password', hash), true)
  assert.equal(await passwords.verifyPassword('wrong-password', hash), false)
  assert.equal(await passwords.verifyPassword('secure-password', 'v2$salt$hash'), false)
  assert.equal(await passwords.verifyPassword('secure-password', 'deadbeef'), false)
  assert.throws(() => passwords.assertPasswordPolicy('short'), /от 8 до 200/)
})
