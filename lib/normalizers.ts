import { ILesson, IClient } from '@/store/models';

export const normalizeLesson = (l: any): ILesson => ({
  id: String(l.id || ''),
  branchId: String(l.branchId || ''),
  dayOfWeek: String(l.dayOfWeek || 'Пн'),
  date: l.date ? String(l.date) : undefined,
  time: String(l.time || '00:00'),
  title: String(l.title || 'Занятие'),
  coachName: String(l.coachName || ''),
  pool: String(l.pool || ''),
  duration: String(l.duration || '1 час'),
  maxCapacity: Number(l.maxCapacity || 10),
  count: String(l.count || '0 / 10'),
});

export const normalizeClient = (c: any): IClient => ({
  ...c,
  id: String(c.id || ''),
  branchId: String(c.branchId || ''),
  paidAmount: Number(c.paidAmount || 0),
  remainingLessons: Number(c.remainingLessons || 0),
  totalLessons: Number(c.totalLessons || 0),
});
