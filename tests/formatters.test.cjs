const test = require('node:test')
const assert = require('node:assert/strict')
const { formatBirthDate, formatPhone } = require('../.test-dist/formatters.js')

test('phone formatter accepts Russian numbers with 7, 8 or no country prefix', () => {
  const expected = '+7 (999) 123-45-67'
  assert.equal(formatPhone('+7 (999) 123-45-67'), expected)
  assert.equal(formatPhone('8 999 123 45 67'), expected)
  assert.equal(formatPhone('9991234567'), expected)
  assert.equal(formatPhone('9'), '+7 (9')
  assert.equal(formatPhone(''), '')
})

test('birth date formatter keeps only DD.MM.YYYY digits', () => {
  assert.equal(formatBirthDate('01021990'), '01.02.1990')
  assert.equal(formatBirthDate('01-02-1990 extra'), '01.02.1990')
  assert.equal(formatBirthDate(''), '')
})
