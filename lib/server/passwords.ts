import 'server-only'

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 200
const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SALT_BYTES = 16
const KEY_BYTES = 64
const MAX_MEMORY_BYTES = 64 * 1024 * 1024

type ParsedPasswordHash = {
  salt: Buffer
  hash: Buffer
}

function parseScryptHash(value: string): ParsedPasswordHash | null {
  const parts = value.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null

  const [_, rawN, rawR, rawP, rawSalt, rawHash] = parts
  if (Number(rawN) !== SCRYPT_N || Number(rawR) !== SCRYPT_R || Number(rawP) !== SCRYPT_P) return null
  if (!/^[A-Za-z0-9_-]+$/.test(rawSalt) || !/^[A-Za-z0-9_-]+$/.test(rawHash)) return null

  try {
    const salt = Buffer.from(rawSalt, 'base64url')
    const hash = Buffer.from(rawHash, 'base64url')
    if (salt.length !== SALT_BYTES || hash.length !== KEY_BYTES) return null
    return { salt, hash }
  } catch {
    return null
  }
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new Error('Пароль должен содержать от 8 до 200 символов')
  }
}

export function isScryptPasswordHash(value: unknown): value is string {
  return typeof value === 'string' && parseScryptHash(value) !== null
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEMORY_BYTES },
      (error, derivedKey) => {
        if (error) reject(error)
        else resolve(Buffer.from(derivedKey))
      },
    )
  })
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password)
  const salt = randomBytes(SALT_BYTES)
  const hash = await deriveKey(password, salt)
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), hash.toString('base64url')].join('$')
}

export async function verifyPassword(password: string, storedHash: unknown): Promise<boolean> {
  if (typeof storedHash !== 'string' || password.length > PASSWORD_MAX_LENGTH) return false
  const parsed = parseScryptHash(storedHash)
  if (!parsed) return false

  const candidate = await deriveKey(password, parsed.salt)
  return candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash)
}
