const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { selectBranchAndReload } = require('../.test-dist/branch-selection.js')

test('branch selection changes scope before forcing shared data to reload', () => {
  const events = []
  selectBranchAndReload(
    {
      setBranch: (branchId) => events.push(['branch', branchId]),
      initialize: (force) => events.push(['reload', force]),
    },
    'branch-500',
  )
  assert.deepEqual(events, [
    ['branch', 'branch-500'],
    ['reload', true],
  ])
})

test('header selector and branch side sheet use the same reload path', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'components', 'AdminWorkspace.tsx'), 'utf8')
  assert.match(page, /onValueChange=\{\(value\) => reloadForBranch\(/)
  assert.match(page, /onClick=\{\(\) => reloadForBranch\(''\)\}/)
  assert.match(page, /onClick=\{\(\) => reloadForBranch\(String\(branch\.id\)\)\}/)
  assert.equal((page.match(/store\.initialize\(true\)/g) || []).length, 0)
})
