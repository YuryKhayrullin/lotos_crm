import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { environmentFile, parseEnv } from './lib/environment.mjs'
import { validateDeployment } from './lib/deployment.mjs'

try {
  if (process.argv.length !== 3) throw Error('Choose explicit staging or production')
  const environment = process.argv[2]
  if (!['staging', 'production'].includes(environment)) throw Error('No Local deployment path')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const filename = path.join(root, environmentFile(environment))
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid?.())
    throw Error('Private owned env file required')
  console.log(JSON.stringify(validateDeployment(parseEnv(fs.readFileSync(filename, 'utf8')), environment)))
} catch {
  console.error(
    'Deployment preflight failed. Check explicit environment, private secrets, roles, HTTPS domain and immutable images; no values logged.',
  )
  process.exitCode = 1
}
