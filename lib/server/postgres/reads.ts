import 'server-only'
import { z } from 'zod'
import type { PrismaClient } from '../../../.generated/prisma/client'
import { branchScope, type Actor } from './access'
import { coachAccounts } from './accounts'
import { coachDto } from './catalog'
import { scheduleRows } from './schedule'
import { dateOnlySchema } from './validation'

const scopeInput = z.object({ branchId: z.string().trim().min(1).max(100).optional() })

export async function bootstrapData(db: PrismaClient, actor: Actor, input: unknown) {
  const body = scopeInput
    .extend({ includeCoaches: z.boolean().optional(), from: dateOnlySchema.optional(), to: dateOnlySchema.optional() })
    .strict()
    .parse(input)
  const today = Date.now()
  const scheduleWindow = {
    from: body.from || new Date(today - 90 * 86400000).toISOString().slice(0, 10),
    to: body.to || new Date(today + 366 * 86400000).toISOString().slice(0, 10),
  }
  const branchId = branchScope(actor, body.branchId)
  const [branches, coaches, lessons] = await Promise.all([
    db.branch.findMany({
      where: { archivedAt: null, ...(actor.role === 'coach' ? { id: actor.branchId! } : {}) },
      select: { id: true, name: true, address: true, timeZone: true },
      orderBy: { name: 'asc' },
    }),
    body.includeCoaches === false
      ? []
      : db.coach.findMany({
          where: { archivedAt: null, ...(branchId ? { branchId } : {}) },
        }),
    scheduleRows(db, actor, { ...scheduleWindow, ...(branchId ? { branchId } : {}) }),
  ])
  return {
    branches,
    coaches: coaches.map((coach) => coachDto(coach, actor)),
    lessons,
    scheduleWindow,
    ...(actor.role === 'admin' && body.includeCoaches !== false ? { coachAccounts: await coachAccounts(db) } : {}),
  }
}

// Minimal real read needed by the existing admin shell, not a fake fallback to
// empty Sheets data. Full catalog/finance endpoints are transferred in stage 5+.
export async function dashboardSummary(db: PrismaClient, actor: Actor, input: unknown) {
  const body = scopeInput
    .extend({ previewLimit: z.number().int().min(1).max(10).optional() })
    .strict()
    .parse(input)
  const branchId = branchScope(actor, body.branchId)
  const where = branchId ? { branchId } : {}
  const [groups, preview] = await Promise.all([
    db.client.groupBy({ by: ['status'], where, _count: true }),
    db.client.findMany({
      where: { ...where, status: { not: 'archived' } },
      take: body.previewLimit || 5,
      orderBy: [{ childName: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        childName: true,
        remainingLessons: true,
        status: true,
        ...(actor.role === 'admin' ? { parentName: true, phone: true } : {}),
      },
    }),
  ])
  const count = (status: string) => groups.find((group) => group.status === status)?._count || 0
  return {
    totalClients: groups.reduce((sum, group) => sum + group._count, 0),
    activeClients: count('active'),
    pausedClients: count('paused'),
    archivedClients: count('archived'),
    previewTotal: count('active') + count('paused'),
    previewLimit: body.previewLimit || 5,
    clientsPreview: preview.map((client) => ({
      id: client.id,
      childName: client.childName,
      parentName: 'parentName' in client ? client.parentName : '',
      phone: 'phone' in client ? client.phone || '' : '',
      initials: client.childName
        .split(/\s+/)
        .slice(0, 2)
        .map((name) => name[0])
        .join(''),
      remainingLessons: client.remainingLessons,
      status: { active: 'Активен', paused: 'Пауза', archived: 'Архив' }[client.status],
    })),
  }
}
