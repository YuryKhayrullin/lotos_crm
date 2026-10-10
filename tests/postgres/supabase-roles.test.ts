import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { Client } from 'pg'
import { validateEnvironment } from '../../scripts/lib/environment.mjs'

validateEnvironment(process.env, 'test')
const container = process.env.LOTOS_TEST_CONTAINER || ''
assert.match(container, /^lotos-crm-test-[a-f0-9]{12}-db-1$/)
const dockerEnv: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: 'unix:///var/run/docker.sock' }
delete dockerEnv.DOCKER_CONTEXT

test('Supabase setup works under a non-superuser operator and denies runtime/anonymous DDL and backup writes', async () => {
  // Only this invocation's random tmpfs test cluster. The postgres database
  // models Supabase's managed database name; no cloud resources are involved.
  const root = new Client({ connectionString: process.env.DATABASE_URL })
  await root.connect()
  const sourceCount = (await root.query('SELECT count(*)::int AS count FROM clients')).rows[0].count
  const operator = new Client({
    host: '127.0.0.1',
    port: 55433,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: 'postgres',
  })
  await operator.connect()
  try {
    await root.query('CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE')
    await root.query('CREATE ROLE anon NOLOGIN')
    await root.query('CREATE ROLE authenticated NOLOGIN')
    await root.query('ALTER DATABASE postgres OWNER TO postgres')
    await operator.query('ALTER SCHEMA public OWNER TO postgres')
    execFileSync(
      'docker',
      ['exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
      {
        env: dockerEnv,
        input: readFileSync('infra/postgres/supabase-staging-roles.sql'),
        stdio: ['pipe', 'ignore', 'pipe'],
        timeout: 15_000,
      },
    )
    await operator.query('SET ROLE lotos_migrator')
    await operator.query('CREATE TABLE public.supabase_role_probe (id integer PRIMARY KEY)')
    await operator.query('INSERT INTO public.supabase_role_probe VALUES (1)')
    await operator.query('RESET ROLE')
    const forbidden = (error: unknown) =>
      Boolean(error && typeof error === 'object' && 'code' in error && error.code === '42501')
    for (const role of ['lotos_runtime', 'lotos_backup']) {
      await operator.query('SET ROLE ' + role)
      assert.equal(
        (await operator.query('SELECT count(*)::int AS count FROM public.supabase_role_probe')).rows[0].count,
        1,
      )
      await assert.rejects(operator.query('CREATE TABLE public.runtime_forbidden (id integer)'), forbidden)
      if (role === 'lotos_backup')
        await assert.rejects(operator.query('DELETE FROM public.supabase_role_probe'), forbidden)
      else {
        await operator.query('INSERT INTO public.supabase_role_probe VALUES (2)')
        await operator.query('DELETE FROM public.supabase_role_probe WHERE id=2')
      }
      const flags = (
        await operator.query(
          'SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user',
        )
      ).rows[0]
      assert.deepEqual(flags, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false })
      await operator.query('RESET ROLE')
    }
    for (const role of ['anon', 'authenticated']) {
      await operator.query('SET ROLE ' + role)
      await assert.rejects(operator.query('SELECT * FROM public.supabase_role_probe'), forbidden)
      await operator.query('RESET ROLE')
    }
    assert.equal((await root.query('SELECT count(*)::int AS count FROM clients')).rows[0].count, sourceCount)
  } finally {
    await operator.query('RESET ROLE')
    await operator.query('DROP TABLE IF EXISTS public.supabase_role_probe')
    await operator.query('ALTER SCHEMA public OWNER TO lotos_test')
    for (const role of ['lotos_migrator', 'lotos_runtime', 'lotos_backup', 'anon', 'authenticated']) {
      await operator.query('DROP OWNED BY ' + role)
      await root.query('DROP ROLE ' + role)
    }
    await root.query('ALTER DATABASE postgres OWNER TO lotos_test')
    await root.query('DROP ROLE postgres')
    await operator.end()
    await root.end()
  }
})
