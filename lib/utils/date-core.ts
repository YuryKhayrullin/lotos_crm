export type LessonDateLike = {
  date?: string | null
  dayOfWeek: string
  isRecurring?: boolean
}

export const isValidDateOnly = (value: string): boolean => parseDateOnly(value) !== null

const parseDateOnly = (value: string): Date | null => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  date.setHours(0, 0, 0, 0)
  return date
}

export const dayOfWeekToNumber = (day: string): number => {
  const days: Record<string, number> = { Пн: 1, Вт: 2, Ср: 3, Чт: 4, Пт: 5, Сб: 6, Вс: 0 }
  return days[day] ?? -1
}

export const isLessonInWeek = (lesson: LessonDateLike, weekStart: Date, weekEnd: Date): boolean => {
  if (lesson.date) {
    const lessonDate = parseDateOnly(lesson.date)
    if (lessonDate) {
      return lessonDate >= weekStart && lessonDate <= weekEnd
    }
  }
  return lesson.isRecurring === true
}

export const isLessonOnDay = (lesson: LessonDateLike, targetDate: Date): boolean => {
  if (lesson.date) {
    const lessonDate = parseDateOnly(lesson.date)
    if (lessonDate) {
      return (
        lessonDate.getDate() === targetDate.getDate() &&
        lessonDate.getMonth() === targetDate.getMonth() &&
        lessonDate.getFullYear() === targetDate.getFullYear()
      )
    }
  }
  return lesson.isRecurring === true && dayOfWeekToNumber(lesson.dayOfWeek) === targetDate.getDay()
}

export const parseTimeToHHMM = (timeInput: unknown): string => {
  if (timeInput === null || timeInput === undefined || timeInput === '') return '--:--'
  const str = String(timeInput).trim()
  if (!str || str === '--:--' || str.toLowerCase() === 'nan') return '--:--'
  const clockMatch = str.match(/^(\d{1,2}):(\d{2})$/)
  if (clockMatch) {
    const hours = Number(clockMatch[1])
    const minutes = Number(clockMatch[2])
    if (hours <= 23 && minutes <= 59) return `${String(hours).padStart(2, '0')}:${clockMatch[2]}`
    return '--:--'
  }
  const num = Number(str)
  if (!isNaN(num) && num >= 0 && num < 1) {
    const totalMinutes = Math.round(num * 24 * 60)
    return `${Math.floor(totalMinutes / 60)
      .toString()
      .padStart(2, '0')}:${(totalMinutes % 60).toString().padStart(2, '0')}`
  }
  if (/^\d{1,2}\.\d{2}$/.test(str)) return str.replace('.', ':').padStart(5, '0')
  if (/^\d{1,2}$/.test(str)) return str.padStart(2, '0') + ':00'
  const date = new Date(str)
  return isNaN(date.getTime())
    ? '--:--'
    : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export const cleanDate = (dateString: string | null | undefined): string => {
  const str = String(dateString || '')
  if (!str || str === 'null' || str === 'undefined' || str.includes('1899-12-30')) return 'Дата не задана'
  const date = parseDateOnly(str)
  return !date ? 'Дата не задана' : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}
