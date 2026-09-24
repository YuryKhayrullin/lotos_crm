import { isLessonInWeek, isLessonOnDay } from './lib/utils/date';
import { ILesson } from './store/models';

// Mock ILesson
const createLesson = (date: string | null, dayOfWeek: string): ILesson => ({
    date,
    dayOfWeek,
    id: '1',
    branchId: '1',
    time: '10:00',
    title: 'Test Lesson',
    // Mock other required fields
} as any);

const weekStart = new Date('2026-09-21T00:00:00'); // Monday
const weekEnd = new Date('2026-09-27T00:00:00'); // Sunday

// Test isLessonInWeek
console.log('Testing isLessonInWeek:');
const lessonWithDateInWeek = createLesson('2026-09-22', 'Вт');
console.log('With date in week:', isLessonInWeek(lessonWithDateInWeek, weekStart, weekEnd) === true);

const lessonWithDateOutWeek = createLesson('2026-09-28', 'Пн');
console.log('With date out of week:', isLessonInWeek(lessonWithDateOutWeek, weekStart, weekEnd) === false);

const lessonNoDate = createLesson(null, 'Пн');
console.log('No date (weekly):', isLessonInWeek(lessonNoDate, weekStart, weekEnd) === true);

// Test isLessonOnDay
console.log('\nTesting isLessonOnDay:');
const targetMonday = new Date('2026-09-21T10:00:00');
const targetTuesday = new Date('2026-09-22T10:00:00');

console.log('Lesson on Monday, target Monday:', isLessonOnDay(createLesson('2026-09-21', 'Пн'), targetMonday) === true);
console.log('Lesson on Monday, target Tuesday:', isLessonOnDay(createLesson('2026-09-21', 'Пн'), targetTuesday) === false);
console.log('Lesson weekly Monday, target Monday:', isLessonOnDay(createLesson(null, 'Пн'), targetMonday) === true);
console.log('Lesson weekly Monday, target Tuesday:', isLessonOnDay(createLesson(null, 'Пн'), targetTuesday) === false);
