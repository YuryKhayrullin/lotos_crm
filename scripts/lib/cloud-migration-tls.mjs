import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cloudDatabaseProvider, cloudDatabaseCertificate } from './cloud-database.mjs'

// The CA is public but still written only into an owned, private temporary
// directory. The operator removes precisely its own file/directory on exit.
export function withCloudMigrationCertificate(values, run) {
  if (cloudDatabaseProvider(values) !== 'supabase') return run({})
  const pem = cloudDatabaseCertificate(values)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lotos-migration-ca-'))
  fs.chmodSync(directory, 0o700)
  const filename = path.join(directory, 'root.crt')
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (fs.existsSync(filename)) fs.unlinkSync(filename)
    fs.rmdirSync(directory)
  }
  try {
    fs.writeFileSync(filename, pem, { flag: 'wx', mode: 0o600 })
    const result = run({ CLOUD_MIGRATION_CA_FILE: filename })
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(cleanup)
    cleanup()
    return result
  } catch (error) {
    cleanup()
    throw error
  }
}

export function prismaCloudMigrationUrl(values, direct) {
  const url = new URL(direct)
  // Prisma's native connector uses sslcert and sslaccept, unlike node-postgres.
  // Explicit require + strict gives CA/hostname verification; never rely on
  // Prisma's default accept_invalid_certs or an unrecognized verify-full mode.
  url.searchParams.set('sslmode', 'require')
  url.searchParams.set('sslaccept', 'strict')
  if (cloudDatabaseProvider(values) === 'supabase') {
    const filename = values.CLOUD_MIGRATION_CA_FILE
    if (!filename || !path.isAbsolute(filename)) throw Error('Operator-managed migration CA required')
    const stat = fs.lstatSync(filename)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.() ||
      fs.readFileSync(filename, 'utf8') !== cloudDatabaseCertificate(values)
    )
      throw Error('Invalid operator-managed migration CA')
    url.searchParams.set('sslcert', filename)
  }
  return url.toString()
}
