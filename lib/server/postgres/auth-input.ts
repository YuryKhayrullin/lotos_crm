import { z } from 'zod'
import { usernameSchema } from './validation'

const id = z.string().trim().min(1).max(100)
export const requestKeySchema = z.string().trim().min(1).max(150)
export const passwordSchema = z.string().min(8).max(200)
export const loginSchema = z.object({ username: usernameSchema, password: z.string().min(1).max(200) }).strict()
export const registrationSchema = loginSchema.extend({ password: passwordSchema, requestId: requestKeySchema }).strict()
export const bootstrapAdminSchema = z
  .object({ username: usernameSchema, name: z.string().trim().min(1).max(150), password: passwordSchema.min(12) })
  .strict()
const mutation = z
  .object({ userId: id, requestId: requestKeySchema, auditReason: z.string().trim().max(500).optional() })
  .strict()
export const accountInputSchemas = {
  assignUserBranch: mutation.extend({ branchId: id }),
  deactivateUser: mutation,
  activateUser: mutation,
  resetCoachPassword: mutation.extend({ newPassword: passwordSchema }),
  revokeUserSessions: mutation,
  linkCoachUser: mutation.extend({ coachId: id }),
} as const
export type AccountAction = keyof typeof accountInputSchemas
