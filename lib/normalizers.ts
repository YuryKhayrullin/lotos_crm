import { parseTimeToHHMM } from './utils/date'

// Using SnapshotIn to match what MST expects for snapshots
import { SnapshotIn } from 'mobx-state-tree'

const normalizeAttendanceHistory = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export const normalizeLesson = (l: any): SnapshotIn<typeof import('@/store/models/Lesson').LessonModel> => ({
  id: String(l.id || ''),
  branchId: String(l.branchId || ''),
  dayOfWeek: String(l.dayOfWeek || 'Пн'),
  date: l.date ? String(l.date) : undefined,
  time: parseTimeToHHMM(l.time),
  title: String(l.title || 'Занятие'),
  category: l.category === 'синхронное плавание' ? 'синхронное плавание' : 'плавание',
  coachName: String(l.coachName || ''),
  coachId: String(l.coachId || ''),
  timeZone: String(l.timeZone || ''),
  startsAt: String(l.startsAt || ''),
  endsAt: String(l.endsAt || ''),
  version: Number.isInteger(l.version) && l.version > 0 ? l.version : 0,
  status: String(l.status || 'scheduled'),
  canEdit: l.canEdit === true,
  canCancel: l.canCancel === true,
  canDelete: l.canDelete === true,
  pool: String(l.pool || ''),
  duration: String(l.duration || '1 час'),
  maxCapacity: Number.isFinite(Number(l.maxCapacity)) && Number(l.maxCapacity) > 0 ? Number(l.maxCapacity) : 10,
  count: String(l.count || '0 / 10'),
  isRecurring: l.isRecurring === true || l.isRecurring === 'true' || l.isRecurring === 'TRUE',
})

export const normalizeClient = (c: any): SnapshotIn<typeof import('@/store/models/Client').ClientModel> => {
  const attendanceHistory = normalizeAttendanceHistory(c.attendanceHistory)
  let assignedLessonIds: string[] = []
  if (c.assignedLessonIds) {
    if (Array.isArray(c.assignedLessonIds)) {
      assignedLessonIds = c.assignedLessonIds.map(String)
    } else {
      assignedLessonIds = String(c.assignedLessonIds)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
  } else if (c.assignedLessonId) {
    assignedLessonIds = [String(c.assignedLessonId)]
  }

  // The backend ledger is the only source for credited lessons. In particular,
  // do not derive a virtual package from lessonsPerWeek or attendance history:
  // frequency describes the next purchase, not previously paid balance.
  const paidValue = c.paid ?? c.subscription?.paid
  const hasRecordedPayment =
    Number(c.paidAmount || 0) > 0 ||
    paidValue === true ||
    paidValue === 1 ||
    String(paidValue || '').toLowerCase() === 'true' ||
    String(paidValue || '') === '1'
  const rawTotalLessons = Number(c.totalLessons ?? 0)
  const rawRemainingLessons = Number(c.remainingLessons ?? 0)
  const hasFlatSubscription = c.remainingLessons !== undefined || c.totalLessons !== undefined

  const flatSubscription = hasFlatSubscription
    ? {
        id: String(c.subscriptionId || `${c.id || 'client'}-subscription`),
        clientId: String(c.id || ''),
        totalLessons: rawTotalLessons,
        remainingLessons: rawRemainingLessons,
        paid: hasRecordedPayment,
        purchasedAt: String(c.purchasedAt || ''),
        receiptUrl: String(c.receiptUrl || ''),
        status: String(c.subscriptionStatus || c.status || 'Активен'),
      }
    : null
  const subscription = c.subscription
    ? {
        id: String(c.subscription.id || `${c.id || 'client'}-subscription`),
        clientId: String(c.id || ''),
        totalLessons: Number(c.subscription.totalLessons ?? 0),
        remainingLessons: Number(c.subscription.remainingLessons ?? 0),
        paid: hasRecordedPayment,
        purchasedAt: String(c.subscription.purchasedAt || ''),
        receiptUrl: String(c.subscription.receiptUrl || ''),
        status: String(c.subscription.status || 'Активен'),
      }
    : flatSubscription

  return {
    receiptVersion: Number.isInteger(c.receiptVersion) && c.receiptVersion >= 0 ? c.receiptVersion : 0,
    id: String(c.id || ''),
    childName: String(c.childName || ''),
    version: Number.isInteger(c.version) && c.version > 0 ? c.version : undefined,
    canDelete: typeof c.canDelete === 'boolean' ? c.canDelete : undefined,
    parentName: String(c.parentName || ''),
    phone: String(c.phone || ''),
    email: String(c.email || ''),
    birthDate: String(c.birthDate || ''),
    age: String(c.age || '0 лет'),
    branchId: String(c.branchId || ''),
    status: c.status === 'Пауза' || c.status === 'Архив' ? c.status : 'Активен',
    category: c.category === 'синхронное плавание' ? 'синхронное плавание' : 'плавание',
    lessonsPerWeek: Number(c.lessonsPerWeek || 1),
    initials: String(c.initials || ''),
    paidAmount: Number(c.paidAmount || 0),
    paymentBalance: Number(c.paymentBalance || 0),
    subscription,
    assignedLessonId: assignedLessonIds[0] || null,
    assignedLessonIds: assignedLessonIds,
    attendanceHistory,
  }
}
