'use client'

import { useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { CalendarDays, Check, Clock3, Loader2, MapPin, RotateCcw, Save, Users, X } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useStore } from '@/store/StoreProvider'
import { apiClient, createRequestId, type LessonRosterClient } from '@/lib/api-client'
import { ILesson } from '@/store/models'

type AttendanceStatus = 'attended' | 'absent'
type AttendanceMap = Record<string, AttendanceStatus | null>

function formatLessonDate(value: string | null) {
  if (!value) return 'Дата не указана'
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return value
  return new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(
    new Date(year, month - 1, day),
  )
}

export const AttendanceModal = observer(
  ({
    isOpen,
    onClose,
    lesson,
    occurrenceDate,
  }: {
    isOpen: boolean
    onClose: () => void
    lesson: ILesson | null
    occurrenceDate: string | null
  }) => {
    const store = useStore()
    const [roster, setRoster] = useState<LessonRosterClient[]>([])
    const [loading, setLoading] = useState(false)
    const [loadError, setLoadError] = useState('')
    const [saveError, setSaveError] = useState('')
    const [reloadToken, setReloadToken] = useState(0)
    const [attendance, setAttendance] = useState<AttendanceMap>({})
    const [initialAttendance, setInitialAttendance] = useState<AttendanceMap>({})
    const [pendingAttempt, setPendingAttempt] = useState<{
      lessonId: string
      date: string
      requestId: string
      attendanceList: { clientId: string; status: AttendanceStatus }[]
    } | null>(null)
    const [saving, setSaving] = useState(false)
    const lessonId = lesson?.id ?? null
    const lessonDate = occurrenceDate

    useEffect(() => {
      if (!isOpen || !lessonId || !lessonDate) return
      const controller = new AbortController()
      setLoading(true)
      setLoadError('')
      setRoster([])
      void apiClient
        .getLessonRoster(lessonId, lessonDate, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return
          setRoster(result.clients)
          if (pendingAttempt?.lessonId === lessonId && pendingAttempt.date === lessonDate) return

          const initialMarks: AttendanceMap = {}
          result.clients.forEach((client) => {
            initialMarks[client.id] = client.mark
          })
          setPendingAttempt(null)
          setSaveError('')
          setAttendance(initialMarks)
          setInitialAttendance(initialMarks)
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить учеников')
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
      return () => controller.abort()
      // Unsaved marks must survive an unrelated client-list refresh.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, lessonDate, lessonId, reloadToken])

    const changedEntries = useMemo(
      () =>
        Object.entries(attendance).filter(
          (entry): entry is [string, AttendanceStatus] => entry[1] !== null && entry[1] !== initialAttendance[entry[0]],
        ),
      [attendance, initialAttendance],
    )
    const attendedCount = roster.filter((client) => attendance[client.id] === 'attended').length
    const absentCount = roster.filter((client) => attendance[client.id] === 'absent').length
    const unmarkedCount = Math.max(0, roster.length - attendedCount - absentCount)

    if (!lesson) return null

    const handleToggle = (clientId: string, status: AttendanceStatus) => {
      if (pendingAttempt) return
      setAttendance((current) => ({
        ...current,
        [clientId]: current[clientId] === status && initialAttendance[clientId] !== status ? null : status,
      }))
    }

    const markEveryonePresent = () => {
      if (pendingAttempt) return
      setAttendance((current) => {
        const next = { ...current }
        roster.forEach((client) => {
          if (client.remainingLessons > 0 || initialAttendance[client.id] === 'attended') next[client.id] = 'attended'
        })
        return next
      })
    }

    const handleSaveAll = async () => {
      if (!pendingAttempt && changedEntries.length === 0) return
      if (!lessonDate || loading || loadError) {
        setSaveError('Не удалось определить дату или загрузить список занятия')
        return
      }

      setSaveError('')
      setSaving(true)
      try {
        const attempt = pendingAttempt || {
          lessonId: lesson.id,
          date: lessonDate,
          requestId: createRequestId(),
          attendanceList: changedEntries.map(([clientId, status]) => ({ clientId, status })),
        }
        setPendingAttempt(attempt)
        await store.clientStore.markBulkAttendance(
          attempt.attendanceList,
          attempt.lessonId,
          attempt.date,
          attempt.requestId,
        )
        setPendingAttempt(null)
        onClose()
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : 'Ошибка при сохранении посещаемости')
        setReloadToken((value) => value + 1)
      } finally {
        setSaving(false)
      }
    }

    return (
      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open && !saving) onClose()
        }}
      >
        <DialogContent className="max-h-[92vh] max-w-[720px] overflow-hidden rounded-[28px] border-0 bg-slate-50 p-0 shadow-2xl">
          <div className="bg-gradient-to-br from-cyan-700 via-cyan-600 to-sky-600 px-6 py-6 text-white sm:px-7">
            <DialogHeader>
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div>
                  <p className="mb-1 text-sm font-medium text-cyan-100">Отметить посещаемость</p>
                  <DialogTitle className="text-2xl font-bold text-white">{lesson.title}</DialogTitle>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-cyan-50">
                    <span className="flex items-center gap-1.5">
                      <CalendarDays className="size-4" /> {formatLessonDate(lessonDate)}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Clock3 className="size-4" /> {String(lesson.time)}
                    </span>
                    {lesson.pool && (
                      <span className="flex items-center gap-1.5">
                        <MapPin className="size-4" /> {lesson.pool}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-cyan-100">
                    {lesson.coachName || 'Тренер не указан'} · {lesson.category}
                  </p>
                </div>
                <div className="flex items-center gap-2 rounded-2xl bg-white/15 px-3 py-2 text-sm font-semibold backdrop-blur-sm">
                  <Users className="size-4" /> {roster.length} учеников
                </div>
              </div>
            </DialogHeader>
          </div>

          <div className="grid gap-4 overflow-y-auto p-5 sm:p-6">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-2xl border border-emerald-100 bg-emerald-50 px-3 py-3 text-center">
                <div className="text-xl font-bold text-emerald-700">{attendedCount}</div>
                <div className="text-xs font-medium text-emerald-700/75">Присутствуют</div>
              </div>
              <div className="rounded-2xl border border-rose-100 bg-rose-50 px-3 py-3 text-center">
                <div className="text-xl font-bold text-rose-700">{absentCount}</div>
                <div className="text-xs font-medium text-rose-700/75">Отсутствуют</div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-center">
                <div className="text-xl font-bold text-slate-700">{unmarkedCount}</div>
                <div className="text-xs font-medium text-slate-500">Не отмечены</div>
              </div>
            </div>

            {(loadError || saveError || !lessonDate) && (
              <div
                role="alert"
                className="rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700"
              >
                {loadError || saveError || 'У занятия не определена дата'}
                {loadError && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="ml-3 rounded-lg border-rose-200 bg-white"
                    onClick={() => setReloadToken((value) => value + 1)}
                  >
                    Повторить
                  </Button>
                )}
              </div>
            )}

            {!loading && !loadError && roster.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-slate-500">Выберите статус для каждого ученика</p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={saving || Boolean(pendingAttempt)}
                    onClick={() => setAttendance({ ...initialAttendance })}
                    className="rounded-xl bg-white"
                  >
                    <RotateCcw className="mr-1.5 size-3.5" /> Сбросить
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={saving || Boolean(pendingAttempt)}
                    onClick={markEveryonePresent}
                    className="rounded-xl border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800"
                  >
                    <Check className="mr-1.5 size-3.5" /> Все пришли
                  </Button>
                </div>
              </div>
            )}

            <div className="min-h-40">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-14 text-slate-500">
                  <Loader2 className="size-5 animate-spin text-cyan-600" /> Загружаем список занятия…
                </div>
              ) : loadError ? null : roster.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
                  <Users className="mx-auto mb-3 size-9 text-slate-300" />
                  <p className="font-semibold text-slate-700">В этой секции пока нет клиентов</p>
                  <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                    Здесь появятся клиенты этого филиала, у которых в карточке выбран вид занятия «{lesson.category}».
                  </p>
                </div>
              ) : (
                <div className="grid max-h-[42vh] gap-2 overflow-y-auto pr-1">
                  {roster.map((client) => {
                    const mark = attendance[client.id]
                    const wasAttended = initialAttendance[client.id] === 'attended'
                    const attendanceDisabled = client.remainingLessons <= 0 && !wasAttended
                    return (
                      <div
                        key={client.id}
                        className={`grid gap-3 rounded-2xl border p-3 transition sm:grid-cols-[1fr_auto] sm:items-center ${
                          mark === 'attended'
                            ? 'border-emerald-200 bg-emerald-50/70'
                            : mark === 'absent'
                              ? 'border-rose-200 bg-rose-50/70'
                              : 'border-slate-200 bg-white'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate font-semibold text-slate-900">{client.childName}</span>
                            <Badge
                              variant={client.remainingLessons > 0 ? 'secondary' : 'destructive'}
                              className="rounded-full text-[11px]"
                            >
                              {client.remainingLessons > 0 ? `${client.remainingLessons} зан.` : 'Нет занятий'}
                            </Badge>
                          </div>
                          {client.parentName && (
                            <p className="mt-0.5 truncate text-sm text-slate-500">{client.parentName}</p>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            aria-pressed={mark === 'attended'}
                            disabled={saving || Boolean(pendingAttempt) || attendanceDisabled}
                            onClick={() => handleToggle(client.id, 'attended')}
                            className={`h-10 min-w-28 rounded-xl ${
                              mark === 'attended'
                                ? 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 hover:text-white'
                                : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800'
                            }`}
                          >
                            <Check className="mr-1.5 size-4" /> Пришёл
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            aria-pressed={mark === 'absent'}
                            disabled={saving || Boolean(pendingAttempt)}
                            onClick={() => handleToggle(client.id, 'absent')}
                            className={`h-10 min-w-28 rounded-xl ${
                              mark === 'absent'
                                ? 'border-rose-600 bg-rose-600 text-white hover:bg-rose-700 hover:text-white'
                                : 'border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800'
                            }`}
                          >
                            <X className="mr-1.5 size-4" /> Не пришёл
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-center text-xs text-slate-500 sm:text-left">
                При отметке «Пришёл» списывается одно занятие
              </p>
              <Button
                onClick={handleSaveAll}
                disabled={
                  saving ||
                  loading ||
                  Boolean(loadError) ||
                  !lessonDate ||
                  (!pendingAttempt && changedEntries.length === 0)
                }
                className="h-11 rounded-xl bg-cyan-600 px-5 font-semibold hover:bg-cyan-700"
              >
                {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
                {saving ? 'Сохраняем…' : `Сохранить${changedEntries.length ? ` · ${changedEntries.length}` : ''}`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    )
  },
)
