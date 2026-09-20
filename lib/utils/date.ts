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

export const cleanDate = (dateString: string | null | undefined): string => {
  if (!dateString || dateString.includes('1899-12-30')) return 'Дата не задана';
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return 'Дата не задана';
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return 'Дата не задана';
  }
};
