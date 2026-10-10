const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const feedback = import('../scripts/lib/bootstrap-feedback.mjs')

test('bootstrap validation and password mismatch produce actionable messages without input values', async () => {
  const { BootstrapInputError, bootstrapValidationError, bootstrapFailureMessage } = await feedback
  const password = 'fictional-secret-never-log-this'
  const cases = [
    [bootstrapValidationError([{ path: ['password'], message: password, input: password }]), /12 до 200/],
    [bootstrapValidationError([{ path: ['username'], input: password }]), /Логин/],
    [bootstrapValidationError([{ path: ['name'], input: password }]), /Имя/],
    [new BootstrapInputError('PASSWORD_MISMATCH'), /не совпадают/],
    [new BootstrapInputError('CANCELLED'), /отменён/],
    [new BootstrapInputError('SQL_EDITOR_REQUIRED'), /cloud:bootstrap:sql/],
  ]
  for (const [error, expected] of cases) {
    const message = bootstrapFailureMessage(error, { phase: 'input' })
    assert.match(message, expected)
    assert.match(message, /Аккаунт не создавался/)
    assert.ok(!message.includes(password))
  }
})

test('bootstrap never echoes raw database errors, credentials, SQL or arbitrary error codes', async () => {
  const { bootstrapFailureMessage, BootstrapInputError } = await feedback
  const secret = 'fictional-password-do-not-output'
  const error = Object.assign(
    Error('postgresql://owner:' + secret + '@fictional.test/db SELECT password FROM accounts'),
    { code: secret, cause: { password: secret } },
  )
  const message = bootstrapFailureMessage(error, { phase: 'creation' })
  assert.match(message, /BOOTSTRAP_UNKNOWN/)
  assert.match(message, /не подтверждено/)
  assert.match(message, /До повторного запуска/)
  assert.doesNotMatch(message, /postgresql|SELECT|accounts/)
  assert.ok(!message.includes(secret))
  assert.ok(!bootstrapFailureMessage(new BootstrapInputError(secret), { phase: 'input' }).includes(secret))
  const tampered = Object.assign(new BootstrapInputError('PASSWORD_LENGTH'), { code: secret, message: secret })
  assert.ok(!bootstrapFailureMessage(tampered, { phase: 'input' }).includes(secret))
})

test('bootstrap recognizes fixed pg timeout/network/TLS indicators without echoing error detail', async () => {
  const { bootstrapFailureMessage } = await feedback
  assert.match(bootstrapFailureMessage(Error('Query read timeout'), { phase: 'creation' }), /BOOTSTRAP_DB_TIMEOUT/)
  assert.match(
    bootstrapFailureMessage(Object.assign(Error('private-detail'), { code: 'EAI_AGAIN' }), { phase: 'preflight' }),
    /BOOTSTRAP_DB_NETWORK/,
  )
  const tls = bootstrapFailureMessage(
    Object.assign(Error('private-detail'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
    { phase: 'preflight' },
  )
  assert.match(tls, /BOOTSTRAP_DB_TLS/)
  assert.doesNotMatch(tls, /private-detail/)
})

test('bootstrap failure reports only allowlisted execution steps and bounded elapsed time', async () => {
  const { bootstrapFailureMessage } = await feedback
  const error = Object.assign(Error('never-print-this'), { code: 'P2028' })
  const message = bootstrapFailureMessage(error, { phase: 'creation', step: 'credential-create', elapsedMs: 10123 })
  assert.match(message, /Шаг: credential-create/)
  assert.match(message, /10123 мс/)
  assert.doesNotMatch(message, /never-print-this/)
  const unsafe = bootstrapFailureMessage(error, {
    phase: 'creation',
    step: 'private-password-or-SQL',
    elapsedMs: 'private-password',
  })
  assert.doesNotMatch(unsafe, /private-password|Шаг:|Время:/)
  for (const elapsedMs of [-1, Infinity, 86_400_001, 'secret']) {
    assert.doesNotMatch(bootstrapFailureMessage(error, { phase: 'creation', step: 'user-create', elapsedMs }), /Время:/)
  }
})

test('bootstrap distinguishes pre-write failure, existing admin and confirmed commit with cleanup failure', async () => {
  const { bootstrapFailureMessage } = await feedback
  const error = Object.assign(Error('never-print-raw-message'), { code: 'P1001' })
  const before = bootstrapFailureMessage(error, { phase: 'preflight' })
  assert.match(before, /P1001/)
  assert.match(before, /ещё не запускалось/)
  const conflict = bootstrapFailureMessage(
    { name: 'PostgresApiError', code: 'CONFLICT', status: 409 },
    { phase: 'creation' },
  )
  assert.match(conflict, /ALREADY_EXISTS/)
  const after = bootstrapFailureMessage(error, { phase: 'disconnect', confirmed: true })
  assert.match(after, /Создание администратора подтверждено/)
  assert.match(after, /Не запускайте/)
  assert.doesNotMatch(after, /не создан|не подтверждено|never-print/)
})

test('bootstrap messages use the real input schema and its password boundaries', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {bootstrapAdminSchema} from './lib/server/postgres/auth-input.ts';
    import {bootstrapValidationError} from './scripts/lib/bootstrap-feedback.mjs';
    for(const length of [0,11,201]) {
      const parsed=bootstrapAdminSchema.safeParse({username:'admin',name:'admin',password:'x'.repeat(length)});
      assert.equal(parsed.success,false);
      assert.equal(bootstrapValidationError(parsed.error.issues).code,'PASSWORD_LENGTH');
    }
    for(const length of [12,200]) assert.equal(bootstrapAdminSchema.safeParse({username:'admin',name:'admin',password:'x'.repeat(length)}).success,true);
  `,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000 },
  )
  assert.equal(result.status, 0, 'Real schema boundaries agree with safe feedback (no credentials logged)')
})

test('bootstrap guards the server transaction before locking and never fetches credential secrets back', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--conditions=react-server',
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import {bootstrapAdmin} from './lib/server/postgres/accounts.ts';
      const steps=[],calls=[];
      const tx={
        $executeRaw:async sql=>{calls.push(sql.join(''));},
        user:{count:async()=>0,create:async input=>{
          assert.deepEqual(input.select,{id:true,username:true});
          return {id:'fictional-id',username:'fictional-admin'};
        }},
        account:{create:async input=>{
          assert.deepEqual(input.select,{id:true});
          assert.notEqual(input.data.password,'fictional-password-123');
          return {id:'fictional-credential'};
        }},
        auditEvent:{create:async input=>{
          assert.deepEqual(input.select,{id:true});
          assert.equal(input.data.action,'bootstrapAdmin');
          return {id:'fictional-audit'};
        }},
      };
      const db={$transaction:async callback=>callback(tx)};
      const user=await bootstrapAdmin(db,{username:'fictional-admin',name:'Fictional admin',password:'fictional-password-123'},step=>steps.push(step));
      assert.deepEqual(user,{id:'fictional-id',username:'fictional-admin'});
      assert.match(calls[0],/^SET LOCAL idle_in_transaction_session_timeout = '10s'$/);
      assert.match(calls[1],/pg_advisory_xact_lock/);
      assert.deepEqual(steps,['password-hash','transaction-start','transaction-guard','management-lock','admin-check','user-create','credential-create','audit-create','transaction-commit']);
      const original=tx.account.create;
      tx.account.create=async()=>{throw Object.assign(Error('private-detail'),{code:'P2028'});};
      steps.length=0;
      await assert.rejects(bootstrapAdmin(db,{username:'fictional-admin',name:'Fictional admin',password:'fictional-password-123'},step=>steps.push(step)),{code:'P2028'});
      assert.equal(steps.at(-1),'credential-create');
      tx.account.create=original;
    `,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000 },
  )
  assert.equal(
    result.status,
    0,
    'Guard ordering, minimal projections and fixed failure step (mock DB, no cloud writes)',
  )
})

test('SQL Editor fallback keeps the atomic bootstrap but contains no psql metacommands or plaintext password', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--conditions=react-server',
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import {buildBootstrapSqlEditorSql} from './scripts/lib/bootstrap-sql.ts';
      const password='fictional-password-never-write';
      const hash='a'.repeat(32)+':'+ 'b'.repeat(128);
      const {sql}=buildBootstrapSqlEditorSql({username:'fictional-admin',name:'Fictional admin',password},hash);
      assert.doesNotMatch(sql,/\\\\echo|fictional-password-never-write/);
      assert.match(sql,/BEGIN;/);
      assert.match(sql,/pg_advisory_xact_lock/);
      assert.match(sql,/BOOTSTRAP_ALREADY_EXISTS/);
      assert.match(sql,/INSERT INTO public\\.users/);
      assert.match(sql,/INSERT INTO public\\.accounts/);
      assert.match(sql,/INSERT INTO public\\.audit_events/);
      assert.match(sql,/COMMIT;/);
      assert.match(sql,/LOTOS_BOOTSTRAP_COMMITTED/);
    `,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000 },
  )
  assert.equal(result.status, 0, 'SQL Editor fallback is generated locally without a database write')
})

test('manual bootstrap rejects a pipe before prompts, SQL or password input', () => {
  const env = {
    ...process.env,
    APP_ENV: 'staging',
    DEPLOY_TARGET: 'vercel',
    CRM_BACKEND: 'postgres',
    BOOTSTRAP_CLOUD_ADMIN: 'explicit-operator',
    APP_URL: 'https://lotos-fictional.vercel.app',
    CLOUD_DATABASE_PROVIDER: 'neon',
    CLOUD_DATABASE_HOST: 'ep-fictional-pooler.eu-central-1.aws.neon.tech',
    DATABASE_URL:
      'postgresql://lotos_runtime:' +
      '1'.repeat(64) +
      '@ep-fictional-pooler.eu-central-1.aws.neon.tech:5432/lotos_crm_staging?sslmode=verify-full',
    BETTER_AUTH_SECRET: '2'.repeat(64),
    DOCUMENT_STORAGE: 'disabled',
    TRUSTED_PROXY: 'vercel',
    COACH_REGISTRATION_ENABLED: 'false',
  }
  for (const name of [
    'DEBUG',
    'NEXT_PUBLIC_DEBUG',
    'CLOUD_SUPABASE_PROJECT_REF',
    'CLOUD_DATABASE_CA_BASE64',
    'BLOB_STORE_ID',
    'BLOB_READ_WRITE_TOKEN',
    'DOCUMENTS_DIR',
    'VERCEL',
    'VERCEL_ENV',
  ])
    delete env[name]
  const result = spawnSync(
    process.execPath,
    ['--conditions=react-server', '--import', 'tsx', 'scripts/bootstrap-admin.ts'],
    {
      cwd: path.resolve(__dirname, '..'),
      env,
      input: 'fictional-password-never-accepted\n',
      encoding: 'utf8',
      timeout: 15000,
    },
  )
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /BOOTSTRAP_INTERACTIVE_REQUIRED/)
  assert.doesNotMatch(result.stderr, /fictional-password-never-accepted|postgresql:\/\//)
})
