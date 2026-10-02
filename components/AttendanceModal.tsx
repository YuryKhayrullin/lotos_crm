'use client'

import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { useStore } from '@/store/StoreProvider'
import { apiClient, createRequestId, type LessonRosterClient } from '@/lib/api-client'
import { ILesson } from '@/store/models'
import { Check, XCircle, Loader2, UserPlus, Save } from 'lucide-react'

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
    const [attendance, setAttendance] = useState<Record<string, 'attended' | 'absent' | null>>({})
    const [initialAttendance, setInitialAttendance] = useState<Record<string, 'attended' | 'absent' | null>>({})
    const [pendingAttempt, setPendingAttempt] = useState<{
      lessonId: string
      date: string
      requestId: string
      attendanceList: { clientId?: string; visitorName?: string; status: 'attended' | 'absent'; isWalkin: boolean }[]
    } | null>(null)
    const [walkinName, setWalkinName] = useState('')
    const [walkins, setWalkins] = useState<string[]>([])
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
          setPendingAttempt(null)
          setSaveError('')
          setWalkins([])
          setWalkinName('')
          const initialMarks: Record<string, 'attended' | 'absent' | null> = {}
          result.clients.forEach((client) => {
            if (client.mark) initialMarks[client.id] = client.mark
          })
          setAttendance(initialMarks)
          setInitialAttendance(initialMarks)
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить учеников')
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
      return () => controller.abort()
      // Keep unsaved marks stable when the unrelated paginated client list refreshes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, lessonDate, lessonId, reloadToken])

    if (!lesson) return null

    // Server result is independent of client-list pagination and search.
    const eligibleClients = roster

    const handleToggle = (clientId: string, status: 'attended' | 'absent') => {
      if (pendingAttempt) return
      setAttendance((prev) => ({
        ...prev,
        [clientId]: prev[clientId] === status && !initialAttendance[clientId] ? null : status,
      }))
    }

    const handleSaveAll = async () => {
      const selected = Object.entries(attendance).filter(
        ([clientId, status]) => status !== null && status !== initialAttendance[clientId],
      )
      if (!pendingAttempt && selected.length === 0 && walkins.length === 0) return

      if (!lessonDate || loading || loadError) {
        setSaveError('Не удалось определить дату или загрузить учеников занятия')
        return
      }
      setSaveError('')

      setSaving(true)
      try {
        const attendanceList = selected.map(([clientId, status]) => ({
          clientId,
          status: status as 'attended' | 'absent',
          isWalkin: false,
        }))
        const walkinList = walkins.map((visitorName) => ({
          visitorName,
          status: 'attended' as const,
          isWalkin: true,
        }))

        const attempt = pendingAttempt || {
          lessonId: lesson.id,
          date: lessonDate,
          requestId: createRequestId(),
          attendanceList: [...attendanceList, ...walkinList],
        }
        setPendingAttempt(attempt)
        await store.clientStore.markBulkAttendance(
          attempt.attendanceList,
          attempt.lessonId,
          attempt.date,
          attempt.requestId,
        )
        setPendingAttempt(null)

        // Для walkin просто закрываем, списания нет
        onClose()
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : 'Ошибка при сохранении посещаемости')
        setReloadToken((value) => value + 1)
      } finally {
        setSaving(false)
      }
    }

    const attendedCount = Object.values(attendance).filter((v) => v === 'attended').length
    const absentCount = Object.values(attendance).filter((v) => v === 'absent').length
    const selectedCount =
      Object.entries(attendance).filter(([id, value]) => value !== null && value !== initialAttendance[id]).length +
      walkins.length

    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-[600px] rounded-3xl p-6 bg-white max-h-[90vh] overflow-y-auto">
          <DialogHeader className="border-b border-slate-100 pb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <DialogTitle className="text-xl font-bold text-cyan-950">
                {lesson.title} · {lesson.time} · {lessonDate || 'дата не задана'}
              </DialogTitle>
              <p className="text-sm text-slate-500 mt-1">
                {lesson.coachName} · {lesson.category} · {eligibleClients.length} доступных учеников
              </p>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-sm font-medium">
                <Check className="inline size-3 mr-1" /> {attendedCount}
              </span>
              <span className="px-3 py-1 bg-rose-100 text-rose-700 rounded-full text-sm font-medium">
                <XCircle className="inline size-3 mr-1" /> {absentCount}
              </span>
              <span className="px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-sm font-medium">
                <UserPlus className="inline size-3 mr-1" /> {walkins.length}
              </span>
              <Button
                onClick={handleSaveAll}
                disabled={
                  saving || loading || Boolean(loadError) || !lessonDate || (!pendingAttempt && selectedCount === 0)
                }
                className="bg-cyan-600 hover:bg-cyan-700 rounded-xl px-4 h-10"
              >
                {saving ? (
                  <Loader2 className="animate-spin size-4" />
                ) : (
                  <>
                    {' '}
                    <Save className="mr-2 size-4" /> Сохранить всё{' '}
                  </>
                )}
              </Button>
            </div>
          </DialogHeader>

          {(loadError || saveError || !lessonDate) && (
            <div role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {loadError || saveError || 'У занятия не определена дата'}
              {loadError && (
                <Button
                  type="button"
                  variant="outline"
                  className="ml-2"
                  onClick={() => setReloadToken((value) => value + 1)}
                >
                  Повторить загрузку
                </Button>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 border-b border-slate-100 pb-4">
            <input
              value={walkinName}
              onChange={(event) => setWalkinName(event.target.value)}
              placeholder="Имя проходного посетителя"
              className="h-10 min-w-0 flex-1 rounded-xl border border-amber-200 bg-amber-50 px-3 text-sm outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
            />
            <Button
              type="button"
              variant="outline"
              disabled={
                !walkinName.trim() || saving || loading || Boolean(loadError) || !lessonDate || Boolean(pendingAttempt)
              }
              onClick={() => {
                setWalkins((current) => [...current, walkinName.trim()])
                setWalkinName('')
              }}
              className="h-10 rounded-xl border-amber-200 text-amber-700"
            >
              <UserPlus className="mr-1.5 size-4" /> Walk-in
            </Button>
          </div>
          {walkins.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {walkins.map((name, index) => (
                <button
                  key={`${name}-${index}`}
                  type="button"
                  onClick={() =>
                    !pendingAttempt && setWalkins((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
                  className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800"
                >
                  {name} ×
                </button>
              ))}
            </div>
          )}

          <div className="grid gap-4 py-4">
            {loading ? (
              <p className="py-8 text-center text-slate-500">Загружаем учеников…</p>
            ) : loadError ? null : eligibleClients.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-slate-500">Нет подходящих учеников</p>
                <p className="text-xs text-slate-400 mt-1">Проверьте, назначены ли дети на это занятие</p>
              </div>
            ) : (
              <div className="grid gap-3 max-h-[60vh] overflow-y-auto pr-2">
                {eligibleClients.map((client) => {
                  const markState = attendance[client.id]
                  const isAttended = markState === 'attended'
                  const isAbsent = markState === 'absent'
                  const cardBg = isAttended
                    ? 'bg-emerald-50 border-emerald-200'
                    : isAbsent
                      ? 'bg-rose-50 border-rose-200'
                      : 'bg-white border-slate-100'

                  return (
                    <Card key={client.id} className={`p-4 rounded-2xl border ${cardBg} shadow-sm transition-all`}>
                      <div className="flex items-center justify-between mb-3">
                        <span className="font-bold text-slate-900 text-lg">{client.childName}</span>
                        <div className="flex items-center gap-2">
                          <Badge variant={client.remainingLessons > 0 ? 'outline' : 'destructive'} className="text-xs">
                            {client.remainingLessons > 0 ? `${client.remainingLessons} зан.` : 'Долг'}
                          </Badge>
                          <Badge variant="secondary" className="text-xs bg-slate-100 text-slate-600">
                            {client.category}
                          </Badge>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          onClick={() => handleToggle(String(client.id), 'attended')}
                          disabled={saving || Boolean(pendingAttempt)}
                          className={`h-12 text-sm font-bold rounded-xl transition-all ${isAttended ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-emerald-500 hover:bg-emerald-600'}`}
                        >
                          <Check className="mr-1.5 size-3.5" /> Был
                        </Button>
                        <Button
                          onClick={() => handleToggle(String(client.id), 'absent')}
                          disabled={saving || Boolean(pendingAttempt)}
                          className={`h-12 text-sm font-bold rounded-xl transition-all ${isAbsent ? 'bg-rose-600 hover:bg-rose-700' : 'bg-rose-500 hover:bg-rose-600'}`}
                        >
                          <XCircle className="mr-1.5 size-3.5" /> Пропуск
                        </Button>
                        {/* Зарегистрированные клиенты отмечаются только с обычным списанием. */}
                      </div>
                    </Card>
                  )
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    )
  },
)
