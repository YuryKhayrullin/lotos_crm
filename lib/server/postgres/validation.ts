import { z } from 'zod'

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/)
export const dateOnlySchema = z.iso.date()
export const timeZoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format()
      return true
    } catch {
      return false
    }
  }, 'Expected an IANA time zone')
export const lessonCreditsSchema = z.number().int().min(0).max(2_147_483_647)
// API transport uses decimal strings of kopecks, not floating point rubles.
export const moneyMinorSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .transform(BigInt)
  .refine((value) => value <= BigInt('9223372036854775807'), 'Amount exceeds PostgreSQL bigint')
export const creditProjectionSchema = z
  .object({
    remainingLessons: lessonCreditsSchema,
    totalLessons: lessonCreditsSchema,
  })
  .strict()
  .refine((value) => value.remainingLessons <= value.totalLessons, 'Remaining exceeds total')
