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

export const toLocalDateOnly = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

// Calendar-only representation; never send this virtual Date as an instant.
export const calendarDayInZone = (instant: Date, timeZone?: string): Date => {
  if (!timeZone) return new Date(instant)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const part = (name: string) => Number(parts.find((value) => value.type === name)?.value)
  return new Date(part('year'), part('month') - 1, part('day'), 12)
}
export const instantTemporalStatus = (startsAt: string, endsAt: string, now: Date): LessonTemporalStatus => {
  const start = Date.parse(startsAt),
    end = Date.parse(endsAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'unknown'
  return now.getTime() < start ? 'upcoming' : now.getTime() < end ? 'ongoing' : 'completed'
}
export const isFutureLocalTime = (date: string, time: string, now: Date, timeZone?: string): boolean => {
  if (!timeZone) return new Date(date + 'T' + time + ':00').getTime() > now.getTime()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const part = (name: string) => parts.find((value) => value.type === name)?.value || ''
  return date + 'T' + time > `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}

// For a recurring lesson, resolve the actual day in the displayed week.
export const lessonOccurrenceDate = (lesson: LessonDateLike, weekStart: Date): string | null => {
  const start = lesson.date ? parseDateOnly(lesson.date) : null
  if (lesson.date && !start) return null
  if (lesson.isRecurring !== true) return start ? toLocalDateOnly(start) : null
  const weekday = dayOfWeekToNumber(lesson.dayOfWeek)
  if (weekday === -1) return null
  const occurrence = new Date(weekStart)
  occurrence.setDate(weekStart.getDate() + ((weekday + 6) % 7))
  if (start && occurrence < start) return null
  return toLocalDateOnly(occurrence)
}

export const isLessonInWeek = (lesson: LessonDateLike, weekStart: Date, weekEnd: Date): boolean => {
  const occurrence = lessonOccurrenceDate(lesson, weekStart)
  const date = occurrence ? parseDateOnly(occurrence) : null
  return date !== null && date >= weekStart && date <= weekEnd
}

export const isLessonOnDay = (lesson: LessonDateLike, targetDate: Date): boolean => {
  const start = lesson.date ? parseDateOnly(lesson.date) : null
  if (lesson.date && !start) return false
  if (lesson.isRecurring === true) {
    return (!start || targetDate >= start) && dayOfWeekToNumber(lesson.dayOfWeek) === targetDate.getDay()
  }
  return start !== null && toLocalDateOnly(start) === toLocalDateOnly(targetDate)
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

export type LessonTemporalStatus = 'upcoming' | 'ongoing' | 'completed' | 'unknown'

export const lessonTemporalStatus = (
  date: string | null,
  time: string,
  duration: string,
  now: Date,
): LessonTemporalStatus => {
  const start = date ? parseDateOnly(date) : null
  const clock = /^(\d{2}):(\d{2})$/.exec(time)
  if (!start || !clock || Number(clock[1]) > 23 || Number(clock[2]) > 59) return 'unknown'
  start.setHours(Number(clock[1]), Number(clock[2]))
  if (now.getTime() < start.getTime()) return 'upcoming'
  const hours = duration.match(/(\d+(?:[.,]\d+)?)\s*(?:час|ч\b)/i)
  const minutes = duration.match(/(\d+)\s*мин/i)
  const length = (hours ? Number(hours[1].replace(',', '.')) * 60 : 0) + (minutes ? Number(minutes[1]) : 0)
  if (!length || !Number.isFinite(length)) return 'unknown'
  return now.getTime() < start.getTime() + length * 60_000 ? 'ongoing' : 'completed'
}
