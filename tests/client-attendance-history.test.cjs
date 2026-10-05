const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const exportsObject = {}
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync(path.join(__dirname, '../components/ClientAttendanceHistory.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
  }).outputText,
  {
    exports: exportsObject,
    require: (name) => (name === '@/lib/utils/date' ? require('../.test-dist/utils/date-core.js') : require(name)),
  },
)
const render = (history, lessons = []) =>
  renderToStaticMarkup(React.createElement(exportsObject.ClientAttendanceHistory, { history, lessons }))

test('attendance history is collapsed by default with visible counts and a bounded dropdown', () => {
  const html = render([{ date: '2026-10-05', lessonId: 'swim', status: 'attended' }])
  assert.match(html, /^<details\b/)
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|\s|>)/)
  const summary = html.match(/<summary\b[^>]*>(.*?)<\/summary>/)[1]
  assert.match(summary, /История посещений/)
  assert.match(summary, /Пришёл: 1 · Пропустил: 0/)
  assert.match(html, /max-h-72/)
  assert.match(html, /overflow-y-auto/)
})

test('client history shows actual attendance dates, lesson and one credit used, newest first', () => {
  const html = render(
    [
      { date: '2026-10-04', lessonId: 'swim', status: 'absent', recordedBy: 'coach' },
      { date: '2026-10-05', lessonId: 'swim', status: 'attended', recordedBy: 'anna' },
    ],
    [{ id: 'swim', title: 'Синхронное плавание', time: '21:00', coachName: 'Анна' }],
  )
  assert.match(html, /5 октября 2026/)
  assert.match(html, /21:00/)
  assert.match(html, /Синхронное плавание/)
  assert.match(html, /Списано 1 занятие/)
  assert.match(html, /Без списания занятий/)
  assert.match(html, /Отметил: anna/)
  assert(html.indexOf('5 октября') < html.indexOf('4 октября'))
})

test('empty and malformed attendance are safe and deleted lessons retain their dated history', () => {
  assert.match(render([null, 2, {}, { status: 'invalid' }]), /Посещений пока нет/)
  const html = render([{ date: '2026-10-05', lessonId: 'deleted', status: 'attended' }])
  assert.match(html, /5 октября/)
  assert.match(html, /Занятие удалено из расписания/)
})
