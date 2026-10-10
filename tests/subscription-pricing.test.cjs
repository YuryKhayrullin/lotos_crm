const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const api = {}
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync('lib/subscription-pricing.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText,
  { exports: api },
)
test('payment preview uses separate integer-kopeck inputs instead of a floating carry sum', () => {
  const result = api.calculatePaymentLessons('плавание', 1, '5499.99', 0.01)
  assert.equal(result.packages, 1)
  assert.equal(result.lessons, 4)
  assert.equal(result.remainder, 0)
  assert.equal(api.calculatePaymentLessons('плавание', 1, '5500.01').remainder, 0.01)
})
test('invalid or fractional-kopeck payment previews do not promise invented lessons', () => {
  for (const amount of ['NaN', '1.001', '-1'])
    assert.equal(api.calculatePaymentLessons('плавание', 1, amount).lessons, 0)
  assert.equal(api.calculatePaymentLessons('unknown', 1, '5500').lessons, 0)
})
