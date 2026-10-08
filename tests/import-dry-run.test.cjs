const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

test('offline XLSX inspector preserves source semantics, rejects unsafe inputs and never reports personal values', () => {
  const result = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      String.raw`
import importlib.util, decimal, tempfile, pathlib, zipfile, json, copy
from xml.sax.saxutils import escape
spec=importlib.util.spec_from_file_location('migration_inspector','scripts/import-dry-run.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
D=decimal.Decimal
assert m.text(D('1789000000000.0'))=='1789000000000'
assert m.text(0)=='0'
assert m.number('',money=True) is None
assert m.number('NaN') is None
assert m.number('1e999999999',money=True) is None
assert m.number('1.001',money=True) is None
assert m.number(True) is None
assert m.number('2.0',integer=True)==2
assert m.date_only(D('46300.0'),(164,'yyyy-mm-dd'))=='2026-10-05'
assert m.date_only(D('46300.0'),(0,'')) is None
assert m.date_only(D('60'),(14,'')) is None
assert m.date_only(D('0'),(14,''),True)=='1904-01-01'
assert m.date_only('31.02.2026') is None
assert m.date_only('12.09.2026')=='2026-09-12'
assert m.clock(D('0.7083333333333334'))=='17:00'
assert m.clock(D('0.875'))=='21:00'
assert m.clock('25:00') is None
assert m.clock(D('1')) is None
assert m.ids('') is None
assert m.ids('[]')==[]
assert m.ids(D('1789000000000.0'))==['1789000000000']
assert m.ids('[1]') is False
assert m.ids('a,b')==['a','b']
try:m.xml(b'<!DOCTYPE x [<!ENTITY a "confidential">]><x>&a;</x>');raise AssertionError('unsafe XML accepted')
except m.InspectionError:pass

def workbook_bytes(formula=False, external=False):
  import io
  buf=io.BytesIO()
  with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as z:
    z.writestr('xl/workbook.xml','<workbook xmlns="'+m.NS['m']+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Users" sheetId="1" r:id="r1"/></sheets></workbook>')
    z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="worksheets/sheet1.xml"'+(' TargetMode="External"' if external else '')+'/></Relationships>')
    z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="'+m.NS['m']+'"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>password</t></is></c></row><row r="2"><c r="A2"><v>1789000000000.0</v></c><c r="B2" t="inlineStr">'+('<f>1+1</f><v>2</v>' if formula else '<is><t>scrypt$DO_NOT_REPORT_PASSWORD_HASH</t></is>')+'</c></row></sheetData></worksheet>')
  return buf.getvalue()
with tempfile.TemporaryDirectory(prefix='lotos-import-test-') as folder:
  file=pathlib.Path(folder)/'fictional.xlsx';file.write_bytes(workbook_bytes())
  before=file.read_bytes();source=m.read_workbook(file);report=m.inspect(source)
  assert source['sheets']['Users']['rows'][0]['values']['id']==D('1789000000000')
  assert report['privacy']['nonemptyPasswordCells']==1
  assert 'DO_NOT_REPORT_PASSWORD_HASH' not in json.dumps(report)
  assert file.read_bytes()==before
  assert report['mode']=='read-only' and report['readyForImport'] is False
  file.write_bytes(workbook_bytes(formula=True));report=m.inspect(m.read_workbook(file))
  assert any(e['code']=='FORMULA_VALUE_NOT_CONFIRMED' for e in report['errors'])
  file.write_bytes(workbook_bytes(external=True))
  try:m.read_workbook(file);raise AssertionError('external relationship accepted')
  except m.InspectionError:pass

def row(values,position=2):return {'row':position,'values':values,'styles':{},'formulaFields':[]}
fixture={'sha256':'0'*64,'date1904':False,'sheets':{name:{'headers':fields[:],'rows':[],'formulaCells':0} for name,fields in m.REQUIRED.items()}}
fixture['sheets']['Филиалы']['rows']=[row({'id':'b','name':'Fictional pool','address':'Fictional','timeZone':'Europe/Moscow'})]
fixture['sheets']['Клиенты']['rows']=[row({'id':'c','branchId':'b','childName':'DO_NOT_REPORT_CHILD_NAME','phone':'DO_NOT_REPORT_PHONE','parentName':'DO_NOT_REPORT_PARENT','category':'плавание','remainingLessons':D(1),'totalLessons':D(1),'paidAmount':D(5500),'paymentBalance':D(0),'attendanceHistory':'[]'})]
fixture['sheets']['Журнал занятий']['rows']=[row({'id':'l','clientId':'c','branchId':'b','type':'legacy_opening_balance','lessonsDelta':D(1),'totalLessonsDelta':D(1),'balanceBefore':D(0),'balanceAfter':D(1),'totalLessonsBefore':D(0),'totalLessonsAfter':D(1)})]
report=m.inspect(fixture)
assert report['accounting'][0]['creditsMatch'] is True
assert any(e['code']=='MONEY_WITHOUT_CONFIRMED_PAYMENTS' for e in report['errors'])
encoded=json.dumps(report)
assert all(v not in encoded for v in ['DO_NOT_REPORT_CHILD_NAME','DO_NOT_REPORT_PHONE','DO_NOT_REPORT_PARENT'])
fixture['sheets']['Клиенты']['rows'][0]['values']['remainingLessons']=D(2)
report=m.inspect(fixture)
assert any(e['code']=='INVALID_CARD_CREDITS' for e in report['errors'])
assert any(e['code']=='CARD_LEDGER_DISCREPANCY' for e in report['errors'])
fixture['sheets']['Клиенты']['rows'][0]['values']['attendanceHistory']=json.dumps([{'lessonId':'unresolved','date':'12.09.2026','status':'attended'}]*2)
report=m.inspect(fixture)
assert any(e['code']=='REPEATED_UNRESOLVED_HISTORY_IDENTITY' for e in report['warnings'])
assert not any(e['code']=='DUPLICATE_CURRENT_ATTENDANCE' for e in report['errors'])
fixture['sheets']['Клиенты']['rows'].append(copy.deepcopy(fixture['sheets']['Клиенты']['rows'][0]))
report=m.inspect(fixture)
assert any(e['code']=='DUPLICATE_ID' for e in report['errors'])
print('Offline inspector assertions passed')
`,
    ],
    {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  )
  assert.equal(result.status, 0, result.error?.message || result.stderr)
  assert.match(result.stdout, /Offline inspector assertions passed/)
})
