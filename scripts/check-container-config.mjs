import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { validateDeployment } from './lib/deployment.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DOCKER_|COMPOSE_)/.test(key)))
try {
  if (process.argv.length !== 2) throw Error()
  const localDriver = path.join(root, '.tools/docker-compose')
  const binary = fs.existsSync(localDriver) ? localDriver : 'docker'
  const prefix = binary === 'docker' ? ['compose'] : []
  for (const environment of ['staging', 'production']) {
    // Fictional values ONLY for config parsing. This script has no up/run path.
    const values = {
      APP_ENV: environment,
      CRM_BACKEND: 'postgres',
      APP_URL: `https://${environment}.fictional.test`,
      CRM_DOMAIN: `${environment}.fictional.test`,
      POSTGRES_DB: 'lotos_crm_' + environment,
      POSTGRES_PASSWORD: '1'.repeat(64),
      RUNTIME_PASSWORD: '2'.repeat(64),
      MIGRATOR_PASSWORD: '3'.repeat(64),
      BACKUP_PASSWORD: '4'.repeat(64),
      BETTER_AUTH_SECRET: '5'.repeat(64),
      DATABASE_URL: `postgresql://lotos_runtime:${'2'.repeat(64)}@db:5432/lotos_crm_${environment}`,
      DIRECT_URL: `postgresql://lotos_migrator:${'3'.repeat(64)}@db:5432/lotos_crm_${environment}`,
      APP_IMAGE: 'sha256:' + '6'.repeat(64),
      MIGRATOR_IMAGE: 'sha256:' + '7'.repeat(64),
      ACME_EMAIL: 'fictional@example.invalid',
      TRUSTED_PROXY: 'caddy',
      COACH_REGISTRATION_ENABLED: 'false',
      DOCUMENTS_DIR: '/var/lib/lotos-crm/documents/' + environment,
      BACKUPS_DIR: '/var/lib/lotos-crm/backups/' + environment,
    }
    validateDeployment(values, environment)
    const result = spawnSync(
      binary,
      [
        ...prefix,
        '--project-name',
        'lotos-config-check-' + environment,
        '--env-file',
        '/dev/null',
        '--file',
        'infra/compose.self-hosted.yaml',
        'config',
        '--quiet',
      ],
      {
        cwd: root,
        env: { ...inherited, ...values, DOCKER_HOST: 'unix:///var/run/docker.sock' },
        encoding: 'utf8',
      },
    )
    if (result.error || result.status !== 0) throw Error()
  }
  console.log(
    'Staging/production Compose configuration passed with fictional values; no containers/deployment/credentials created.',
  )
} catch {
  console.error('Container configuration validation failed; no deployment performed.')
  process.exitCode = 1
}
