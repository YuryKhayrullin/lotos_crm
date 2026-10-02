const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api-client.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText

function apiWithFetch(fetch) {
  const exports = {}
  const context = {
    exports,
    fetch,
    console: { log() {} },
    require: (name) => {
      assert.equal(name, './normalizers')
      return { normalizeClient: (value) => value, normalizeLesson: (value) => value }
    },
  }
  vm.createContext(context)
  vm.runInContext(compiled, context)
  return exports.apiClient
}

test('attendance batches more than 100 marks and reuses stable chunk IDs on retry', async () => {
  const requests = []
  const saved = new Set()
  let failSecondChunkOnce = true
  const fetch = async (_url, options) => {
    const { action, payload } = JSON.parse(options.body)
    assert.equal(action, 'recordBulkAttendance')
    requests.push(payload)
    if (payload.requestId === 'attempt:1' && failSecondChunkOnce) {
      failSecondChunkOnce = false
      throw new Error('temporary network failure')
    }
    const results = payload.attendance.map((item) => {
      const key = `${payload.requestId}:${item.clientId}`
      const duplicate = saved.has(key)
      saved.add(key)
      return { clientId: item.clientId, success: true, duplicate }
    })
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true, results }),
    }
  }
  const api = apiWithFetch(fetch)
  const marks = Array.from({ length: 101 }, (_, index) => ({
    clientId: `child-${index + 1}`,
    status: 'attended',
  }))

  await assert.rejects(
    api.recordBulkAttendance(marks, 'lesson-1', '2026-10-02', 'attempt'),
    /temporary network failure/,
  )
  const retried = await api.recordBulkAttendance(marks, 'lesson-1', '2026-10-02', 'attempt')
  assert.equal(retried.success, true)
  assert.equal(retried.results.length, 101)
  assert.equal(retried.results.filter((result) => result.duplicate).length, 100)
  assert.deepEqual(
    requests.map((request) => request.attendance.length),
    [100, 1, 100, 1],
  )
  assert.deepEqual(
    requests.map((request) => request.requestId),
    ['attempt:0', 'attempt:1', 'attempt:0', 'attempt:1'],
  )
  assert.equal(saved.size, 101)
})
