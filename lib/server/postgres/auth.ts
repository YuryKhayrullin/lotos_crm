import 'server-only'
import { betterAuth } from 'better-auth'
import { prismaAdapter } from '@better-auth/prisma-adapter'
import { username } from 'better-auth/plugins'
import type { PrismaClient } from '../../../.generated/prisma/client'
import { validateEnvironment } from '../../../scripts/lib/environment.mjs'
import { usernameSchema } from './validation'

// Only our explicit adapter routes are public, never auth.handler wholesale.
export function createPostgresAuth(prisma: PrismaClient, values: NodeJS.ProcessEnv) {
  validateEnvironment(values, values.APP_ENV)
  return betterAuth({
    appName: 'Lotos CRM',
    baseURL: values.APP_URL,
    secret: values.BETTER_AUTH_SECRET,
    trustedOrigins: [values.APP_URL!],
    database: prismaAdapter(prisma, { provider: 'postgresql', transaction: true }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      revokeSessionsOnPasswordReset: true,
      minPasswordLength: 8,
      maxPasswordLength: 200,
    },
    rateLimit: { enabled: false }, // Public facade enforces atomic PostgreSQL budgets.
    session: {
      expiresIn: 60 * 60 * 8,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
      additionalFields: { authVersion: { type: 'number', defaultValue: 1, input: false } },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await prisma.user.findUnique({
              where: { id: session.userId },
              select: { status: true, authVersion: true },
            })
            if (user?.status !== 'active') return false
            return { data: { ...session, authVersion: user.authVersion } }
          },
        },
      },
    },
    user: {
      additionalFields: {
        role: { type: ['admin', 'coach'], defaultValue: 'coach', input: false },
        status: { type: ['pending', 'active', 'disabled'], defaultValue: 'pending', input: false },
        branchId: { type: 'string', required: false, input: false },
        authVersion: { type: 'number', defaultValue: 1, input: false },
      },
    },
    advanced: {
      database: { generateId: 'uuid' },
      cookiePrefix: 'lotos',
      useSecureCookies: values.APP_ENV === 'staging' || values.APP_ENV === 'production',
    },
    disabledPaths: ['/is-username-available'],
    plugins: [
      username({
        displayUsername: false,
        immutableUsername: true,
        minUsernameLength: 3,
        maxUsernameLength: 64,
        usernameValidator: (value) => usernameSchema.safeParse(value).success,
        usernameNormalization: (value) => value.trim().toLowerCase(),
      }),
    ],
    logger: { disabled: true },
  })
}
