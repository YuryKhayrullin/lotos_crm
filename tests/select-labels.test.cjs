const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const exportsForSelect = {}
const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', 'components/ui/select.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText
vm.runInNewContext(compiled, {
  exports: exportsForSelect,
  require(name) {
    if (name === '@/lib/utils') return { cn: (...values) => values.filter(Boolean).join(' ') }
    return require(name)
  },
})
const { Select, SelectTrigger, SelectValue } = exportsForSelect

function displayedValue(value, items) {
  const html = renderToStaticMarkup(
    React.createElement(
      Select,
      { value, items },
      React.createElement(
        SelectTrigger,
        { 'aria-label': 'Филиал' },
        React.createElement(SelectValue, { placeholder: 'Выберите филиал' }),
      ),
    ),
  )
  const match = html.match(/data-slot="select-value"[^>]*>([^<]*)<\/span>/)
  assert(match, 'select must render its visible value')
  return match[1]
}

test('real Base UI renders the branch label before any popup is mounted, never its database ID', () => {
  assert.equal(
    displayedValue('1789036797270', [{ value: '1789036797270', label: 'Основной бассейн' }]),
    'Основной бассейн',
  )
})

test('real Base UI renders one placeholder for null and a readable account name for its ID', () => {
  const items = [{ value: '1799036797270', label: 'anna' }]
  assert.equal(displayedValue(null, items), 'Выберите филиал')
  assert.equal(displayedValue('1799036797270', items), 'anna')
})
