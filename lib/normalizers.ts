import { parseTimeToHHMM } from './utils/date'

// Using SnapshotIn to match what MST expects for snapshots
import { SnapshotIn } from 'mobx-state-tree'
import { countAttendedLessons, packageLessonsFromFrequency } from './subscription-pricing'

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
  pool: String(l.pool || ''),
  duration: String(l.duration || '1 час'),
  maxCapacity: Number(l.maxCapacity || 10),
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

  const inferredTotalLessons = packageLessonsFromFrequency(c.lessonsPerWeek) || null
  const rawTotalLessons = Number(c.totalLessons ?? 0)
  const rawRemainingLessons = Number(c.remainingLessons ?? 0)
  const hasFlatSubscription = c.remainingLessons !== undefined || c.totalLessons !== undefined
  const shouldInferEmptySubscription = hasFlatSubscription && rawTotalLessons <= 0 && rawRemainingLessons <= 0
  const totalLessons = rawTotalLessons > 0 ? rawTotalLessons : (inferredTotalLessons ?? 0)
  const remainingLessons =
    rawTotalLessons > 0 || rawRemainingLessons > 0
      ? rawRemainingLessons
      : Math.max(0, totalLessons - countAttendedLessons(attendanceHistory))

  const flatSubscription =
    hasFlatSubscription || inferredTotalLessons !== null
      ? {
          id: String(c.subscriptionId || `${c.id || 'client'}-subscription`),
          clientId: String(c.id || ''),
          totalLessons: shouldInferEmptySubscription || !hasFlatSubscription ? totalLessons : rawTotalLessons,
          remainingLessons:
            shouldInferEmptySubscription || !hasFlatSubscription ? remainingLessons : rawRemainingLessons,
          paid: String(c.paid ?? true) === 'true' || c.paid === true || c.paid === 1,
          purchasedAt: String(c.purchasedAt || new Date().toISOString()),
          receiptUrl: String(c.receiptUrl || ''),
          status: String(c.subscriptionStatus || c.status || 'Активен'),
        }
      : null

  const subscription = c.subscription
    ? {
        id: String(c.subscription.id || `${c.id || 'client'}-subscription`),
        clientId: String(c.id || ''),
        totalLessons: Number(c.subscription.totalLessons ?? 0) > 0 ? Number(c.subscription.totalLessons) : totalLessons,
        remainingLessons:
          Number(c.subscription.totalLessons ?? 0) > 0 || Number(c.subscription.remainingLessons ?? 0) > 0
            ? Number(c.subscription.remainingLessons ?? 0)
            : remainingLessons,
        paid:
          String(c.subscription.paid).toLowerCase() === 'true' ||
          c.subscription.paid === true ||
          c.subscription.paid === 1 ||
          String(c.subscription.paid) === '1',
        purchasedAt: String(c.subscription.purchasedAt || new Date().toISOString()),
        receiptUrl: String(c.subscription.receiptUrl || ''),
        status: String(c.subscription.status || 'Активен'),
      }
    : flatSubscription

  return {
    id: String(c.id || ''),
    childName: String(c.childName || ''),
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
    subscription,
    assignedLessonId: assignedLessonIds[0] || null,
    assignedLessonIds: assignedLessonIds,
    attendanceHistory,
  }
}
