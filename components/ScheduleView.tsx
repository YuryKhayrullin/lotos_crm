import { useState, useMemo, useEffect, Fragment } from 'react'
import dynamic from 'next/dynamic'
import { observer } from 'mobx-react-lite'
import { getStore } from '@/store/RootStore'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AttendanceModal } from './AttendanceModal'
import { ILesson } from '@/store/models'
import {
  CalendarDays,
  CalendarX,
  ChevronLeft,
  ChevronRight,
  Clock3,
  MapPin,
  Plus,
  RotateCcw,
  Users,
} from 'lucide-react'
import {
  parseTimeToHHMM,
  cleanDate,
  isLessonInWeek,
  isLessonOnDay,
  lessonOccurrenceDate,
  lessonTemporalStatus,
  calendarDayInZone,
  instantTemporalStatus,
} from '@/lib/utils/date'
import { RoleGuard } from './RoleGuard'
import { apiClient } from '@/lib/api-client'
import { LessonManagementModal } from './LessonManagementModal'

const store = getStore()
const CreateLessonModal = dynamic(() => import('./CreateLessonModal').then((module) => module.CreateLessonModal))

// Обновленная функция с учетом смещения
const getStartOfWeek = (offset: number, today: string) => {
  const d = new Date(today)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1) + offset * 7
  const start = new Date(d.setDate(diff))
  start.setHours(0, 0, 0, 0)
  return start
}

const isToday = (date: Date, today = new Date()) => {
  return (
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  )
}

export const ScheduleView = observer(() => {
  const [weekOffset, setWeekOffset] = useState(0)
  const [isCreateLessonOpen, setIsCreateLessonOpen] = useState(false)
  const [managementLesson, setManagementLesson] = useState<ILesson | null>(null)
  const [scheduleRefresh, setScheduleRefresh] = useState(0)
  const [scheduleError, setScheduleError] = useState('')
  const [scheduleLoading, setScheduleLoading] = useState(false)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const refresh = () => setNow(new Date())
    const timer = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  const native = apiClient.isPostgresBackend?.() === true
  const calendarNow = native ? calendarDayInZone(now, store.currentBranch?.timeZone || 'Europe/Moscow') : now
  const todayKey = calendarNow.toDateString()

  const startOfWeek = useMemo(() => getStartOfWeek(weekOffset, todayKey), [weekOffset, todayKey])
  const endOfWeek = useMemo(() => {
    const end = new Date(startOfWeek)
    end.setDate(startOfWeek.getDate() + 6)
    return end
  }, [startOfWeek])
  const canCreate = store.authStore.isAdmin || native
  const selectedBranchId = store.selectedBranchId
  useEffect(() => {
    if (!native) return
    const controller = new AbortController()
    const date = (value: Date) =>
      `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    setScheduleLoading(true)
    setScheduleError('')
    void apiClient
      .fetchSchedule(date(startOfWeek), date(endOfWeek), selectedBranchId || undefined, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted)
          store.rememberSchedule(rows, date(startOfWeek), date(endOfWeek), selectedBranchId || undefined)
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setScheduleError(error instanceof Error ? error.message : 'Не удалось загрузить расписание')
      })
      .finally(() => {
        if (!controller.signal.aborted) setScheduleLoading(false)
      })
    return () => controller.abort()
  }, [native, startOfWeek, endOfWeek, selectedBranchId, scheduleRefresh])

  const DAYS = useMemo(
    () =>
      ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label, i) => {
        const d = new Date(startOfWeek)
        d.setDate(startOfWeek.getDate() + i)
        return { key: label, label: `${label} ${d.getDate()}`, fullDate: d }
      }),
    [startOfWeek],
  )

  const [dayChoice, setSelectedDay] = useState<string | null>(null)
  const selectedDay = dayChoice || DAYS[calendarNow.getDay() === 0 ? 6 : calendarNow.getDay() - 1]?.key || 'Пн'
  const [selectedLesson, setSelectedLesson] = useState<ILesson | null>(null)
  const [selectedOccurrenceDate, setSelectedOccurrenceDate] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'день' | 'неделя'>('день')

  // Получаем выбранную дату для режима "день"
  const selectedDayData = DAYS.find((d) => d.key === selectedDay)
  const sortedBranchLessons = store.sortedBranchLessons

  // Фильтрация уроков с учетом РЕАЛЬНЫХ дат
  const lessons = useMemo(() => {
    const branchLessons = sortedBranchLessons

    if (viewMode === 'неделя') {
      // В режиме неделя: показываем уроки, дата которых попадает в текущую неделю
      return branchLessons.filter((l) => isLessonInWeek(l, startOfWeek, endOfWeek))
    } else {
      // В режиме день: показываем уроки на выбранную дату
      if (!selectedDayData) return []
      return branchLessons.filter((l) => isLessonOnDay(l, selectedDayData.fullDate))
    }
  }, [sortedBranchLessons, viewMode, startOfWeek, endOfWeek, selectedDayData])

  const statusLabels = {
    ongoing: 'Идёт сейчас',
    upcoming: 'Предстоящие',
    completed: 'Завершённые',
    unknown: 'Время требует проверки',
  }
  const statusOrder = { ongoing: 0, upcoming: 1, completed: 2, unknown: 3 }
  const displayedLessons = lessons
    .map((lesson) => {
      const occurrenceDate = lessonOccurrenceDate(lesson, startOfWeek)
      return {
        lesson,
        occurrenceDate,
        status: native
          ? instantTemporalStatus(lesson.startsAt, lesson.endsAt, now)
          : lessonTemporalStatus(occurrenceDate, parseTimeToHHMM(lesson.time), lesson.duration, now),
      }
    })
    .sort(
      (left, right) =>
        statusOrder[left.status] - statusOrder[right.status] ||
        `${left.occurrenceDate} ${left.lesson.time}`.localeCompare(`${right.occurrenceDate} ${right.lesson.time}`),
    )

  const branch = store.currentBranch
  const selectedDateLabel = selectedDayData
    ? selectedDayData.fullDate.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })
    : ''

  const weekRange = `${startOfWeek.getDate()} ${startOfWeek.toLocaleString('ru-RU', { month: 'short' })} – ${endOfWeek.getDate()} ${endOfWeek.toLocaleString('ru-RU', { month: 'short' })} ${endOfWeek.getFullYear()}`

  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-hidden rounded-3xl border border-slate-200/80 bg-white">
        <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-cyan-600 text-white shadow-lg shadow-cyan-200">
              <CalendarDays className="size-6" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-700">Расписание</p>
              <h2 className="truncate text-2xl font-bold tracking-tight text-slate-950">
                {branch ? branch.name : 'Все филиалы'}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {viewMode === 'день' ? selectedDateLabel : `Всего занятий на неделе: ${lessons.length}`}
              </p>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <div className="flex rounded-xl bg-slate-100 p-1">
              {(['день', 'неделя'] as const).map((mode) => (
                <Button
                  key={mode}
                  variant="ghost"
                  size="sm"
                  onClick={() => setViewMode(mode)}
                  className={
                    viewMode === mode
                      ? 'rounded-lg bg-white text-cyan-700 shadow-sm hover:bg-white'
                      : 'rounded-lg text-slate-500'
                  }
                >
                  {mode === 'день' ? 'День' : 'Неделя'}
                </Button>
              ))}
            </div>
            <RoleGuard roles={native ? ['admin', 'coach'] : ['admin']}>
              <Button
                onClick={() => setIsCreateLessonOpen(true)}
                className="h-10 flex-1 rounded-xl bg-cyan-600 px-4 text-white shadow-sm hover:bg-cyan-700 sm:flex-none"
              >
                <Plus className="mr-1.5 size-4" /> Новое занятие
              </Button>
            </RoleGuard>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-cyan-100/70 px-3 py-2 sm:px-5">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Предыдущая неделя"
            onClick={() => setWeekOffset((prev) => prev - 1)}
            className="rounded-xl text-slate-500 hover:text-cyan-700"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div className="flex items-center gap-2 text-center text-sm font-medium text-slate-600">
            <span>{weekRange}</span>
            {weekOffset !== 0 && (
              <button
                type="button"
                onClick={() => {
                  setWeekOffset(0)
                  setSelectedDay(null)
                }}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-cyan-700 hover:bg-cyan-50"
              >
                <RotateCcw className="size-3" /> Сегодня
              </button>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Следующая неделя"
            onClick={() => setWeekOffset((prev) => prev + 1)}
            className="rounded-xl text-slate-500 hover:text-cyan-700"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-2">
        {DAYS.map((d) => (
          <button
            key={d.key}
            onClick={() => {
              setSelectedDay(d.key)
              setViewMode('день')
            }}
            className={`min-w-[74px] rounded-2xl border px-4 py-2.5 text-sm font-semibold whitespace-nowrap shadow-sm transition-all ${
              viewMode === 'день' && selectedDay === d.key
                ? 'bg-cyan-500 text-white border-cyan-500 shadow-cyan-100'
                : isToday(d.fullDate, calendarNow)
                  ? 'bg-cyan-50 text-cyan-700 border-cyan-200'
                  : 'bg-white text-slate-700 border-slate-100 hover:border-cyan-200 hover:bg-slate-50'
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      <AttendanceModal
        isOpen={!!selectedLesson}
        onClose={() => setSelectedLesson(null)}
        lesson={selectedLesson}
        occurrenceDate={selectedOccurrenceDate}
      />

      {canCreate && isCreateLessonOpen && (
        <CreateLessonModal
          isOpen
          onClose={() => {
            setIsCreateLessonOpen(false)
            setScheduleRefresh((value) => value + 1)
          }}
        />
      )}
      {managementLesson && (
        <LessonManagementModal
          lesson={managementLesson}
          onClose={() => setManagementLesson(null)}
          onSaved={() => setScheduleRefresh((value) => value + 1)}
        />
      )}
      {scheduleLoading && <p role="status">Загружаем выбранную неделю…</p>}
      {scheduleError && (
        <p role="alert">
          {scheduleError}{' '}
          <Button variant="outline" onClick={() => setScheduleRefresh((value) => value + 1)}>
            Повторить загрузку
          </Button>
        </p>
      )}

      <div className="grid gap-4">
        {lessons.length === 0 ? (
          <Card className="rounded-3xl border-dashed border-cyan-200 bg-cyan-50/30 p-8 text-center shadow-none sm:p-12">
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-white text-cyan-600 shadow-sm">
              <CalendarX className="size-6" />
            </div>
            <h3 className="mt-4 font-bold text-slate-900">Занятий пока нет</h3>
            <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
              {viewMode === 'день' ? `На ${selectedDateLabel} ничего не запланировано` : 'На этой неделе занятий нет'}
            </p>
            <RoleGuard roles={native ? ['admin', 'coach'] : ['admin']}>
              <Button
                onClick={() => setIsCreateLessonOpen(true)}
                className="mt-5 rounded-xl bg-cyan-600 text-white hover:bg-cyan-700"
              >
                <Plus className="mr-1.5 size-4" /> Добавить занятие
              </Button>
            </RoleGuard>
          </Card>
        ) : (
          displayedLessons.map(({ lesson, occurrenceDate, status }, index) => {
            const maxCap = lesson.maxCapacity || 10

            return (
              <Fragment key={lesson.id}>
                {(index === 0 || displayedLessons[index - 1].status !== status) && (
                  <h3 className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-600">
                    {statusLabels[status]}
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
                      {displayedLessons.filter((entry) => entry.status === status).length}
                    </span>
                  </h3>
                )}
                <Card
                  key={lesson.id}
                  className="group cursor-pointer overflow-hidden rounded-3xl border border-slate-200/80 bg-white ring-0 shadow-none transition-all hover:border-cyan-200 hover:shadow-md"
                  onClick={() => {
                    if (lesson.status === 'cancelled') return
                    setSelectedOccurrenceDate(occurrenceDate)
                    setSelectedLesson({ ...lesson })
                  }}
                >
                  <CardContent className="flex items-center justify-between gap-4 p-4 sm:p-5">
                    <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                      <div
                        className={`h-16 w-1.5 shrink-0 rounded-full transition-colors ${
                          lesson.category === 'синхронное плавание'
                            ? 'bg-pink-400 group-hover:bg-pink-500'
                            : 'bg-cyan-500 group-hover:bg-cyan-600'
                        }`}
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <Badge
                            className={
                              status === 'completed'
                                ? 'bg-slate-100 text-slate-600'
                                : status === 'ongoing'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-cyan-50 text-cyan-700'
                            }
                          >
                            {lesson.status === 'cancelled'
                              ? 'Отменено'
                              : status === 'completed'
                                ? 'Завершено'
                                : status === 'ongoing'
                                  ? 'Идёт сейчас'
                                  : status === 'upcoming'
                                    ? 'Запланировано'
                                    : 'Проверьте время'}
                          </Badge>
                          <p className="text-xl font-extrabold tabular-nums text-cyan-950">
                            {parseTimeToHHMM(lesson.time)}
                          </p>
                          <p className="text-xs font-semibold text-cyan-700">{cleanDate(occurrenceDate)}</p>
                        </div>
                        <button
                          type="button"
                          disabled={lesson.status === 'cancelled'}
                          aria-label={'Открыть занятие: ' + lesson.title + ' · ' + cleanDate(occurrenceDate)}
                          className="mt-1 block max-w-full truncate text-left font-semibold text-slate-900 focus-visible:rounded focus-visible:outline-2 focus-visible:outline-cyan-700"
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedOccurrenceDate(occurrenceDate)
                            setSelectedLesson({ ...lesson })
                          }}
                        >
                          {lesson.title}
                        </button>
                        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            <Users className="size-3.5" /> {lesson.coachName || 'Тренер не назначен'}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="size-3.5" /> {lesson.pool || 'Бассейн'}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock3 className="size-3.5" /> {lesson.duration || '1 час'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2 sm:gap-4">
                      <Badge className="rounded-xl bg-cyan-50 px-2.5 py-1 text-xs font-bold text-cyan-700 sm:text-sm">
                        До {maxCap}
                      </Badge>
                      {native && (lesson.canEdit || lesson.canCancel || lesson.canDelete) && (
                        <Button
                          variant="outline"
                          onClick={(event) => {
                            event.stopPropagation()
                            setManagementLesson({ ...lesson })
                          }}
                        >
                          Изменить
                        </Button>
                      )}
                      <div className="px-1 text-xl font-bold text-slate-300 transition-colors group-hover:text-cyan-600 sm:px-2">
                        ›
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Fragment>
            )
          })
        )}
      </div>
    </div>
  )
})
