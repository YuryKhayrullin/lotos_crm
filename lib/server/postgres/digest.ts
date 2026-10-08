import 'server-only'
import { createHmac } from 'node:crypto'

export function authDigest(secret: string, namespace: string, value: unknown): string {
  return createHmac('sha256', secret)
    .update(namespace + ':' + JSON.stringify(value))
    .digest('hex')
}
