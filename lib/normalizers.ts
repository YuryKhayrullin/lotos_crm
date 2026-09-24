import { ILessonSnapshot, IClientSnapshot } from '@/store/models';
import { parseTimeToHHMM } from './utils/date';

export const normalizeLesson = (l: any): ILessonSnapshot => ({
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
});

export const normalizeClient = (c: any): IClientSnapshot => {
  // Parse assignedLessonIds from comma-separated string (Google Sheets format)
  let assignedLessonIds: string[] = [];
  if (c.assignedLessonIds) {
    if (Array.isArray(c.assignedLessonIds)) {
      assignedLessonIds = c.assignedLessonIds.map(String);
    } else {
      assignedLessonIds = String(c.assignedLessonIds).split(',').map(s => s.trim()).filter(Boolean);
    }
  } else if (c.assignedLessonId) {
    assignedLessonIds = [String(c.assignedLessonId)];
  }

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
    subscription: c.subscription ? {
      id: String(c.subscription.id || Date.now().toString()),
      clientId: String(c.id || ''),
      totalLessons: Number(c.subscription.totalLessons || 0),
      remainingLessons: Number(c.subscription.remainingLessons || 0),
      paid: String(c.subscription.paid) === 'true' || c.subscription.paid === true,
      purchasedAt: String(c.subscription.purchasedAt || new Date().toISOString()),
      receiptUrl: String(c.subscription.receiptUrl || ''),
      status: String(c.subscription.status || 'Активен')
    } : null,
    assignedLessonId: assignedLessonIds[0] || null,
    assignedLessonIds: assignedLessonIds,
  };
};