import { ILesson } from '@/store/models';

export const dayOfWeekToNumber = (day: string): number => {
  const days: Record<string, number> = { 'Пн': 1, 'Вт': 2, 'Ср': 3, 'Чт': 4, 'Пт': 5, 'Сб': 6, 'Вс': 0 };
  return days[day] ?? -1;
};

export const isLessonInWeek = (lesson: ILesson, weekStart: Date, weekEnd: Date): boolean => {
  if (lesson.date) {
    const lessonDate = new Date(lesson.date);
    if (!isNaN(lessonDate.getTime())) {
      lessonDate.setHours(0, 0, 0, 0);
      return lessonDate >= weekStart && lessonDate <= weekEnd;
    }
  }
  // If no date, it's NOT in any week by default (must have explicit date)
  // Only show if it's explicitly marked as recurring
  return lesson.isRecurring === true;
};

export const isLessonOnDay = (lesson: ILesson, targetDate: Date): boolean => {
  if (lesson.date) {
    const lessonDate = new Date(lesson.date);
    if (!isNaN(lessonDate.getTime())) {
      return (
        lessonDate.getDate() === targetDate.getDate() &&
        lessonDate.getMonth() === targetDate.getMonth() &&
        lessonDate.getFullYear() === targetDate.getFullYear()
      );
    }
  }
  // If no date, only show if recurring and dayOfWeek matches
  if (lesson.isRecurring === true) {
    const dayNum = dayOfWeekToNumber(lesson.dayOfWeek);
    return dayNum === targetDate.getDay();
  }
  return false;
};

export const formatLessonDate = (dateString: string | null | undefined): string => {
  if (!dateString) return 'Дата не задана';
  if (dateString.includes('1899-12-30')) return 'Дата не задана';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return 'Дата не задана';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};

export const cleanTime = (timeStr?: string | null): string => {
  if (!timeStr) return '--:--';
  if (/^\d{2}:\d{2}$/.test(timeStr)) return timeStr;
  
  try {
    const date = new Date(timeStr);
    if (isNaN(date.getTime())) return '--:--';
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
};

/**
 * Парсит время из любого формата в строгий HH:mm
 * Поддерживает: "18:00", "18.00", "6pm", "18", 0.75 (Excel), Date, числа
 * Возвращает "HH:mm" или "--:--" если не удалось распарсить
 */
export const parseTimeToHHMM = (timeInput: any): string => {
  if (timeInput === null || timeInput === undefined || timeInput === '') return '--:--';
  
  const str = String(timeInput).trim();
  if (!str || str === '--:--' || str.toLowerCase() === 'nan') return '--:--';
  
  // Уже в правильном формате
  if (/^\d{2}:\d{2}$/.test(str)) return str;
  
  // Формат с точкой: "18.00" → "18:00"
  if (/^\d{1,2}\.\d{2}$/.test(str)) {
    return str.replace('.', ':').padStart(5, '0');
  }
  
  // Только часы: "18" или "6" → "18:00" / "06:00"
  if (/^\d{1,2}$/.test(str)) {
    return str.padStart(2, '0') + ':00';
  }
  
  // Excel serial number (0.75 = 18:00)
  const num = Number(str);
  if (!isNaN(num) && num >= 0 && num < 1) {
    const totalMinutes = Math.round(num * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }
  
  // Попытка распарсить как Date
  try {
    const date = new Date(str);
    if (!isNaN(date.getTime())) {
      return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
  } catch {}
  
  return '--:--';
};

export const cleanDate = (dateString: string | null | undefined): string => {
  const str = String(dateString || '');
  if (!str || str === 'null' || str === 'undefined' || str.includes('1899-12-30')) return 'Дата не задана';
  try {
    const date = new Date(str);
    if (isNaN(date.getTime())) return 'Дата не задана';
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return 'Дата не задана';
  }
};
