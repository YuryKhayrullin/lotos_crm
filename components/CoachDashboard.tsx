'use client'

import { useState } from 'react'
import { ArrowRight, CalendarCheck2, CalendarDays, ChevronLeft, ChevronRight, Clock3, MapPin } from 'lucide-react'
import { ILesson } from '@/store/models'
import { isLessonOnDay, parseTimeToHHMM, toLocalDateOnly } from '@/lib/utils/date'

// Navigation uses the already-loaded schedule, never a network request.
const moveDay = (date: Date, offset: number) => {
  const result = new Date(date)
  result.setHours(12, 0, 0, 0)
  result.setDate(result.getDate() + offset)
  return result
}
const dateLabel = (date: Date) => date.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })
const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600'

type Props = {
  lessons: ILesson[]
  branchName: string
  now: Date
  onSchedule: () => void
  onOpenLesson: (lesson: ILesson, date: Date) => void
}

export function CoachDashboard({ lessons, branchName, now, onSchedule, onOpenLesson }: Props) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [weekOffset, setWeekOffset] = useState(0)
  const todayKey = toLocalDateOnly(now)
  const selectedKey = selectedDate || todayKey
  const selectedDay = selectedDate ? new Date(selectedDate + 'T12:00:00') : now
  const monday = moveDay(now, -((now.getDay() + 6) % 7))
  // Preserve chronological order even if an upstream snapshot was unsorted.
  const sortableTime = (lesson: ILesson) => {
    const time = parseTimeToHHMM(lesson.time)
    return /^\d{2}:\d{2}$/.test(time) ? time : '99:99'
  }
  const orderedLessons = lessons.slice().sort((a, b) => sortableTime(a).localeCompare(sortableTime(b)))
  const currentWeek = Array.from({ length: 7 }, (_, index) => {
    const date = moveDay(monday, index)
    return { date, lessons: orderedLessons.filter((lesson) => isLessonOnDay(lesson, date)) }
  })
  const days =
    weekOffset === 0
      ? currentWeek
      : Array.from({ length: 7 }, (_, index) => {
          const date = moveDay(monday, weekOffset * 7 + index)
          return { date, lessons: orderedLessons.filter((lesson) => isLessonOnDay(lesson, date)) }
        })
  const todayLessons = orderedLessons.filter((lesson) => isLessonOnDay(lesson, now))
  const selectedLessons = orderedLessons.filter((lesson) => isLessonOnDay(lesson, selectedDay))
  const weekCount = currentWeek.reduce((total, day) => total + day.lessons.length, 0)
  const nextOccurrence = (() => {
    for (let offset = 0; offset < 14; offset++) {
      const date = moveDay(now, offset)
      const lesson = orderedLessons.find((item) => {
        if (!isLessonOnDay(item, date)) return false
        const time = parseTimeToHHMM(item.time)
        return (
          /^\d{2}:\d{2}$/.test(time) &&
          (offset > 0 ||
            Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) >= now.getHours() * 60 + now.getMinutes())
        )
      })
      if (lesson) return { lesson, date }
    }
    return null
  })()
  const navigateWeek = (direction: number) => {
    const offset = weekOffset + direction
    setWeekOffset(offset)
    setSelectedDate(toLocalDateOnly(moveDay(monday, offset * 7)))
  }
  const stats = [
    { label: 'Занятий сегодня', value: String(todayLessons.length), detail: dateLabel(now), icon: CalendarCheck2 },
    { label: 'На этой неделе', value: String(weekCount), detail: 'По расписанию вашего филиала', icon: CalendarDays },
    {
      label: 'Ближайшее занятие',
      value: nextOccurrence ? parseTimeToHHMM(nextOccurrence.lesson.time) : '—',
      detail: nextOccurrence ? dateLabel(nextOccurrence.date) : 'Нет в ближайшие 14 дней',
      icon: Clock3,
    },
  ]

  return (
    <>
      <section className="relative overflow-hidden rounded-[28px] bg-gradient-to-br from-[#103c4a] via-[#0c5265] to-[#078b9e] p-5 text-white sm:p-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-12 -top-24 size-80 rounded-full border-[35px] border-white/5"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-36 right-24 size-80 rounded-full border-[35px] border-white/5"
        />
        <div className="relative flex flex-wrap items-center justify-between gap-6">
          <div className="max-w-lg">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">
              Ваше рабочее пространство
            </p>
            <h1 className="text-2xl font-bold tracking-tight sm:text-4xl">Ваш день — в одном месте.</h1>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-cyan-50/80">
              Откройте занятие, отметьте учеников и сохраните посещаемость. Просто, быстро, по делу.
            </p>
          </div>
          <button
            type="button"
            onClick={onSchedule}
            className={`flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-cyan-950 shadow-sm hover:bg-cyan-50 ${focus}`}
          >
            Открыть расписание
            <ArrowRight className="size-4" />
          </button>
        </div>
      </section>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {stats.map(({ label, value, detail, icon: Icon }) => (
          <div key={label} className="min-w-0 rounded-2xl border border-slate-200/70 bg-white p-3 sm:p-5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-medium text-slate-500 sm:text-xs">{label}</p>
              <Icon className="hidden size-4 shrink-0 text-cyan-600 sm:block" />
            </div>
            <p className="mt-3 text-xl font-semibold tracking-tight sm:text-3xl">{value}</p>
            <p className="mt-1 hidden text-xs text-slate-500 sm:block">{detail}</p>
          </div>
        ))}
      </div>
      <div>
        <h2 className="text-xl font-bold tracking-tight">
          {selectedKey === todayKey ? 'Сегодня в расписании' : 'Занятия на выбранный день'}
        </h2>
        <p className="mt-1 text-sm text-slate-500">{dateLabel(selectedDay)}</p>
      </div>
      <section className="overflow-hidden rounded-3xl border border-slate-200/80 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:px-6">
          <p className="text-sm font-semibold capitalize">
            {days[0].date.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setWeekOffset(0)
                setSelectedDate(null)
              }}
              className={`rounded-lg px-3 py-2 text-xs font-medium text-cyan-700 hover:bg-cyan-50 ${focus}`}
            >
              Сегодня
            </button>
            <button
              type="button"
              aria-label="Предыдущая неделя"
              onClick={() => navigateWeek(-1)}
              className={`rounded-lg border border-slate-200 p-2 hover:bg-slate-50 ${focus}`}
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Следующая неделя"
              onClick={() => navigateWeek(1)}
              className={`rounded-lg border border-slate-200 p-2 hover:bg-slate-50 ${focus}`}
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 border-b border-slate-100 p-3 sm:gap-2 sm:p-5">
          {days.map((day) => {
            const key = toLocalDateOnly(day.date)
            return (
              <button
                key={key}
                type="button"
                aria-label={dateLabel(day.date)}
                aria-pressed={selectedKey === key}
                onClick={() => setSelectedDate(key)}
                className={`flex min-w-0 flex-col items-center gap-1 rounded-xl py-3 transition-colors sm:rounded-2xl ${focus} ${selectedKey === key ? 'bg-cyan-700 text-white shadow-md shadow-cyan-100' : key === todayKey ? 'bg-cyan-50 text-cyan-800' : 'text-slate-500 hover:bg-slate-50'}`}
              >
                <span className="text-[10px] font-medium sm:text-xs">
                  {day.date.toLocaleDateString('ru-RU', { weekday: 'short' })}
                </span>
                <span className="text-lg font-semibold sm:text-2xl">{day.date.getDate()}</span>
                <span
                  aria-hidden="true"
                  className={`mt-1 size-1 rounded-full ${day.lessons.length ? (selectedKey === key ? 'bg-cyan-200' : 'bg-cyan-600') : 'bg-transparent'}`}
                />
              </button>
            )
          })}
        </div>
        {selectedLessons.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-10 text-center sm:py-14">
            <span className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-cyan-50 text-cyan-700">
              <CalendarCheck2 className="size-8" />
            </span>
            <h3 className="text-lg font-semibold">
              {selectedKey === todayKey ? 'На сегодня занятий нет.' : 'На этот день занятий нет.'}
            </h3>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-slate-500">
              Выберите другой день в календаре или откройте полное расписание филиала.
            </p>
            {nextOccurrence && (
              <button
                type="button"
                onClick={() => onOpenLesson(nextOccurrence.lesson, nextOccurrence.date)}
                className={`mt-5 flex flex-wrap items-center justify-center gap-2 rounded-xl border border-cyan-100 bg-cyan-50 px-4 py-3 text-sm font-medium text-cyan-800 ${focus}`}
              >
                Ближайшее: {nextOccurrence.lesson.title} ·{' '}
                {nextOccurrence.date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} ·{' '}
                {parseTimeToHHMM(nextOccurrence.lesson.time)}
                <ArrowRight className="size-4" />
              </button>
            )}
          </div>
        ) : (
          <div className="grid gap-3 p-4 sm:p-6">
            {selectedLessons.map((lesson) => (
              <button
                key={lesson.id}
                type="button"
                aria-label={`Отметить посещаемость: ${lesson.title}, ${parseTimeToHHMM(lesson.time) || 'время не указано'}`}
                onClick={() => onOpenLesson(lesson, selectedDay)}
                className={`group flex flex-wrap items-center gap-4 rounded-2xl border border-slate-100 bg-white p-4 text-left transition-colors hover:border-cyan-200 hover:bg-cyan-50/40 sm:p-5 ${focus}`}
              >
                <span className="flex min-w-20 flex-col items-center rounded-xl bg-cyan-50 px-3 py-3 text-cyan-800">
                  <span className="text-xl font-bold tracking-tight">{parseTimeToHHMM(lesson.time) || '—'}</span>
                  <span className="mt-1 text-[10px]">{lesson.duration || 'Занятие'}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-semibold sm:text-lg">{lesson.title}</span>
                  <span className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                    <MapPin className="size-3.5 shrink-0" />
                    {lesson.pool || branchName}
                  </span>
                  {lesson.coachName && <span className="mt-1 block text-xs text-slate-500">{lesson.coachName}</span>}
                </span>
                <span className="flex items-center gap-2 text-xs font-semibold text-cyan-700">
                  <span className="hidden sm:inline">Отметить посещаемость</span>
                  <ArrowRight className="size-5" />
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/50 px-6 py-4">
          <p className="text-xs text-slate-500">Отметки записываются в таблицу после сохранения.</p>
          <button
            type="button"
            onClick={onSchedule}
            className={`flex items-center gap-1 text-xs font-semibold text-cyan-700 ${focus}`}
          >
            Всё расписание
            <ArrowRight className="size-3" />
          </button>
        </div>
      </section>
    </>
  )
}
