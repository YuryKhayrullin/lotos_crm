import { randomUUID } from 'node:crypto'
import { bootstrapAdminSchema } from '../../lib/server/postgres/auth-input'
import { BootstrapInputError } from './bootstrap-feedback.mjs'

// Used only by the manual operator, never an HTTP route or a migration.
// Hex JSON keeps names/newlines/backslashes out of SQL and psql metacommands.
export function buildBootstrapSql(input: unknown, passwordHash: string) {
  const data = bootstrapAdminSchema.parse(input)
  if (data.name.includes('\0')) throw new BootstrapInputError('INVALID_NAME')
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash)) throw Error('Invalid credential hash')
  const id = randomUUID()
  const payload = Buffer.from(
    JSON.stringify({
      id,
      accountId: randomUUID(),
      auditId: randomUUID(),
      username: data.username,
      name: data.name,
      passwordHash,
    }),
    'utf8',
  ).toString('hex')
  const sql = `\\echo LOTOS_BOOTSTRAP_STEP:transaction-start
BEGIN;
\\echo LOTOS_BOOTSTRAP_STEP:transaction-guard
SET LOCAL idle_in_transaction_session_timeout = '10s';
SET LOCAL statement_timeout = '10s';
\\echo LOTOS_BOOTSTRAP_STEP:management-lock
SELECT pg_advisory_xact_lock(hashtextextended('lotos-auth-management-v1', 0));
DO $lotos_owner_bootstrap$
DECLARE
  payload jsonb := convert_from(decode('${payload}', 'hex'), 'UTF8')::jsonb;
BEGIN
  RAISE NOTICE 'LOTOS_BOOTSTRAP_STEP:admin-check';
  IF EXISTS (SELECT 1 FROM public.users WHERE role = 'admin') THEN
    RAISE EXCEPTION 'BOOTSTRAP_ALREADY_EXISTS';
  END IF;
  RAISE NOTICE 'LOTOS_BOOTSTRAP_STEP:user-create';
  INSERT INTO public.users (id, username, name, role, status, updated_at)
    VALUES (payload->>'id', payload->>'username', payload->>'name', 'admin', 'active', now());
  RAISE NOTICE 'LOTOS_BOOTSTRAP_STEP:credential-create';
  INSERT INTO public.accounts (id, user_id, account_id, provider_id, password, updated_at)
    VALUES (payload->>'accountId', payload->>'id', payload->>'id', 'credential', payload->>'passwordHash', now());
  RAISE NOTICE 'LOTOS_BOOTSTRAP_STEP:audit-create';
  INSERT INTO public.audit_events (id, actor_id, action, entity_type, entity_id, changed_fields, source)
    VALUES (payload->>'auditId', payload->>'id', 'bootstrapAdmin', 'user', payload->>'id',
      ARRAY['username', 'role', 'status', 'password'], 'bootstrap-cli');
END
$lotos_owner_bootstrap$;
\\echo LOTOS_BOOTSTRAP_STEP:transaction-commit
COMMIT;
SELECT 'LOTOS_BOOTSTRAP_COMMITTED';
`
  return { sql, user: { id, username: data.username } }
}

// Fallback for the Supabase dashboard SQL Editor when the owner's local
// WSL/Docker -> pooler connection is unstable. The file contains a one-way
// Better Auth hash, never the plaintext password. The same database lock,
// admin guard and atomic transaction are retained.
export function buildBootstrapSqlEditorSql(input: unknown, passwordHash: string) {
  const { sql, user } = buildBootstrapSql(input, passwordHash)
  return {
    sql:
      '-- Lotos CRM: one-time first administrator bootstrap.\n' +
      '-- Run the whole file once in the dedicated staging Supabase SQL Editor.\n' +
      sql
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('\\'))
        .join('\n') +
      '\n',
    user,
  }
}

export const bootstrapPreflightSql = `SELECT json_build_object(
  'role', current_user,
  'database', current_database(),
  'admins', (SELECT count(*)::int FROM public.users WHERE role = 'admin'),
  'authLockAvailable', pg_try_advisory_xact_lock(hashtextextended('lotos-auth-management-v1', 0))
);`
