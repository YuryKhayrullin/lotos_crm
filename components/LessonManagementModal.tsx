'use client'

import { useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiClient } from '@/lib/api-client'
import { useStore } from '@/store/StoreProvider'
import type { ILesson } from '@/store/models'

export function LessonManagementModal({
  lesson,
  onClose,
  onSaved,
}: {
  lesson: ILesson
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const store = useStore()
  const session = store.authStore.sessionVersion
  const [title, setTitle] = useState(lesson.title)
  const [pool, setPool] = useState(lesson.pool)
  const [date, setDate] = useState(lesson.date || '')
  const [time, setTime] = useState(String(lesson.time))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const running = useRef(false)
  async function submit(action: 'updateLesson' | 'cancelLesson' | 'deleteLesson') {
    if (running.current || confirmed) return
    if (
      action === 'deleteLesson' &&
      !window.confirm('Удалить это пустое будущее занятие? Исторические занятия удалять нельзя.')
    )
      return
    running.current = true
    setBusy(true)
    setError('')
    try {
      const fields =
        action === 'updateLesson'
          ? {
              ...(title !== lesson.title ? { title } : {}),
              ...(pool !== lesson.pool ? { pool } : {}),
              ...(date !== lesson.date ? { date } : {}),
              ...(time !== String(lesson.time) ? { time } : {}),
            }
          : action === 'cancelLesson'
            ? { reason }
            : {}
      await apiClient.changeLesson(action, lesson.id, { expectedVersion: lesson.version, ...fields })
      if (store.authStore.sessionVersion !== session) return
      setConfirmed(true)
      try {
        await onSaved()
      } catch {
        setError('Изменение сохранено. Не удалось обновить расписание; закройте диалог и повторите чтение.')
        return
      }
      onClose()
    } catch (failure) {
      if (store.authStore.sessionVersion === session)
        setError(failure instanceof Error ? failure.message : 'Не удалось изменить занятие')
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running.current) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Управление занятием</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-slate-500">
          Изменяется только этот экземпляр, не вся серия. При наличии отметок перенос даты и отмена запрещены.
        </p>
        <fieldset disabled={busy || confirmed} className="grid gap-3">
          <label>
            Название
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Бассейн
            <Input value={pool} onChange={(event) => setPool(event.target.value)} />
          </label>
          <label>
            Дата
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label>
            Время
            <Input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
          </label>
          {lesson.canEdit && <Button onClick={() => void submit('updateLesson')}>Сохранить изменения</Button>}
          {lesson.canCancel && (
            <>
              <label>
                Причина отмены
                <Input maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
              </label>
              <Button variant="outline" disabled={!reason.trim()} onClick={() => void submit('cancelLesson')}>
                Отменить занятие
              </Button>
            </>
          )}
          {lesson.canDelete && (
            <Button variant="destructive" onClick={() => void submit('deleteLesson')}>
              Удалить пустое занятие
            </Button>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {confirmed && (
          <Button variant="outline" onClick={onClose}>
            Закрыть подтверждённое изменение
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}
