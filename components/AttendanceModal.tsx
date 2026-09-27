'use client'

import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { useStore } from '@/store/StoreProvider'
import { ILesson } from '@/store/models'
import { Check, XCircle, Loader2, UserPlus, Save } from 'lucide-react'

export const AttendanceModal = observer(
  ({ isOpen, onClose, lesson }: { isOpen: boolean; onClose: () => void; lesson: ILesson | null }) => {
    const store = useStore()
    const [attendance, setAttendance] = useState<Record<string, 'attended' | 'absent' | 'walkin' | null>>({})
    const [walkinName, setWalkinName] = useState('')
    const [walkins, setWalkins] = useState<string[]>([])
    const [saving, setSaving] = useState(false)
    const lessonId = lesson?.id ?? null
    const lessonDate = lesson?.date ?? null

    useEffect(() => {
      if (!isOpen) {
        setAttendance({})
        setWalkins([])
        setWalkinName('')
        return
      }

      if (!lessonId || !lessonDate) return

      const initialMarks: Record<string, 'attended' | 'absent' | 'walkin' | null> = {}
      store.branchClients.forEach((client) => {
        const history = Array.isArray(client.attendanceHistory) ? client.attendanceHistory : []
        const mark = history.find((entry) => {
          if (!entry || typeof entry !== 'object') return false
          const value = entry as { lessonId?: unknown; date?: unknown }
          return String(value.lessonId) === String(lessonId) && String(value.date) === String(lessonDate)
        }) as { status?: unknown; isWalkin?: unknown } | undefined

        if (mark?.isWalkin === true) initialMarks[client.id] = 'walkin'
        else if (mark?.status === 'attended' || mark?.status === 'absent') {
          initialMarks[client.id] = mark.status
        }
      })
      setAttendance(initialMarks)
      // branchClients is a computed slice created on every render; requestVersion
      // is the stable signal emitted when its server data changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, lessonDate, lessonId, store.clientStore.requestVersion, store.selectedBranchId])

    if (!lesson) return null

    // В посещаемости показываем только активных клиентов, назначенных на это занятие.
    const eligibleClients = store.branchClients.filter((c) => {
      if (c.status === 'Архив') return false
      if (lesson.category && c.category && c.category !== lesson.category) return false
      if (!c.isAssignedTo(lesson.id)) return false
      return true
    })

    const handleToggle = (clientId: string, status: 'attended' | 'absent' | 'walkin') => {
      setAttendance((prev) => ({
        ...prev,
        [clientId]: prev[clientId] === status ? null : status,
      }))
    }

    const handleSaveAll = async () => {
      const selected = Object.entries(attendance).filter(([, status]) => status !== null)
      if (selected.length === 0 && walkins.length === 0) return

      // Валидация: у урока должна быть дата
      if (!lesson.date) {
        alert('У занятия не задана дата. Нельзя отметить посещаемость.')
        return
      }

      setSaving(true)
      try {
        const attendanceList = selected.map(([clientId, status]) => ({
          clientId,
          status: status === 'walkin' ? 'attended' : status, // walkin считается как attended на бэке, но не списываем
          isWalkin: status === 'walkin',
        }))
        const walkinList = walkins.map((visitorName) => ({
          visitorName,
          status: 'attended' as const,
          isWalkin: true,
        }))

        await store.clientStore.markBulkAttendance(
          [...attendanceList, ...walkinList] as {
            clientId?: string
            visitorName?: string
            status: 'attended' | 'absent'
            isWalkin: boolean
          }[],
          lesson.id,
          lesson.date,
        )

        // Для walkin просто закрываем, списания нет
        onClose()
      } catch {
        alert('Ошибка при сохранении посещаемости')
      } finally {
        setSaving(false)
      }
    }

    const attendedCount = Object.values(attendance).filter((v) => v === 'attended').length
    const absentCount = Object.values(attendance).filter((v) => v === 'absent').length
    const walkinCount = Object.values(attendance).filter((v) => v === 'walkin').length
    const selectedCount = attendedCount + absentCount + walkinCount + walkins.length

    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-[600px] rounded-3xl p-6 bg-white max-h-[90vh] overflow-y-auto">
          <DialogHeader className="border-b border-slate-100 pb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <DialogTitle className="text-xl font-bold text-cyan-950">
                {lesson.title} · {lesson.time}
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
                <UserPlus className="inline size-3 mr-1" /> {walkinCount}
              </span>
              <Button
                onClick={handleSaveAll}
                disabled={saving || selectedCount === 0}
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
              disabled={!walkinName.trim() || saving}
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
                  onClick={() => setWalkins((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800"
                >
                  {name} ×
                </button>
              ))}
            </div>
          )}

          <div className="grid gap-4 py-4">
            {eligibleClients.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-slate-500">Нет подходящих учеников</p>
                <p className="text-xs text-slate-400 mt-1">
                  Проверьте: статус «Активен», есть занятия на абонементе, категория совпадает
                </p>
              </div>
            ) : (
              <div className="grid gap-3 max-h-[60vh] overflow-y-auto pr-2">
                {eligibleClients.map((client) => {
                  const markState = attendance[client.id]
                  const isAttended = markState === 'attended'
                  const isAbsent = markState === 'absent'
                  const isWalkin = markState === 'walkin'

                  const cardBg = isAttended
                    ? 'bg-emerald-50 border-emerald-200'
                    : isAbsent
                      ? 'bg-rose-50 border-rose-200'
                      : isWalkin
                        ? 'bg-amber-50 border-amber-200'
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

                      <div className="grid grid-cols-3 gap-2">
                        <Button
                          onClick={() => handleToggle(String(client.id), 'attended')}
                          disabled={saving}
                          className={`h-12 text-sm font-bold rounded-xl transition-all ${isAttended ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-emerald-500 hover:bg-emerald-600'}`}
                        >
                          <Check className="mr-1.5 size-3.5" /> Был
                        </Button>
                        <Button
                          onClick={() => handleToggle(String(client.id), 'absent')}
                          disabled={saving}
                          className={`h-12 text-sm font-bold rounded-xl transition-all ${isAbsent ? 'bg-rose-600 hover:bg-rose-700' : 'bg-rose-500 hover:bg-rose-600'}`}
                        >
                          <XCircle className="mr-1.5 size-3.5" /> Пропуск
                        </Button>
                        <Button
                          onClick={() => handleToggle(String(client.id), 'walkin')}
                          disabled={saving}
                          variant="outline"
                          className={`h-12 text-sm font-bold rounded-xl transition-all ${isWalkin ? 'bg-amber-600 hover:bg-amber-700 text-white border-amber-600' : 'bg-amber-50 hover:bg-amber-100 border-amber-200 text-amber-700'}`}
                        >
                          <UserPlus className="mr-1.5 size-3.5" /> Проходное
                        </Button>
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
