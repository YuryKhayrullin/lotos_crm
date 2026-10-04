'use client'

import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { CalendarPlus, Clock3, LoaderCircle, UserRound, UsersRound } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useStore } from '@/store/StoreProvider'
import { isValidDateOnly, parseTimeToHHMM } from '@/lib/utils/date'
import { apiClient, type ClientOption } from '@/lib/api-client'

const LESSON_TIME_OPTIONS = Array.from({ length: 36 }, (_, index) => {
  const minutes = 6 * 60 + index * 30
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
})

export const CreateLessonModal = observer(({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
  const store = useStore()
  const today = () => {
    const date = new Date()
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const defaultBranchId = store.selectedBranchId || (store.branches.length === 1 ? String(store.branches[0].id) : '')
  const [formData, setFormData] = useState({
    date: today(),
    time: '17:00',
    coachName: store.branchCoaches[0]?.name || '',
    clientId: '',
    branchId: defaultBranchId,
    category: 'плавание' as 'плавание' | 'синхронное плавание',
  })
  const [formError, setFormError] = useState('')
  const [clientOptions, setClientOptions] = useState<ClientOption[]>([])
  const [clientsLoading, setClientsLoading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const selectedClient = clientOptions.find((client) => client.id === formData.clientId)
  const availableCoaches = store.coaches.filter((coach) => String(coach.branchId) === formData.branchId)

  useEffect(() => {
    if (!isOpen || !formData.branchId) {
      setClientOptions([])
      setClientsLoading(false)
      return
    }
    const controller = new AbortController()
    setClientsLoading(true)
    void apiClient
      .searchClientOptions('', controller.signal, formData.branchId, 500, formData.category)
      .then((options) => {
        if (!controller.signal.aborted) setClientOptions(options)
      })
      .catch(() => {
        if (!controller.signal.aborted) setClientOptions([])
      })
      .finally(() => {
        if (!controller.signal.aborted) setClientsLoading(false)
      })
    return () => {
      controller.abort()
    }
  }, [formData.branchId, formData.category, isOpen])

  const handleSubmit = async () => {
    if (isSubmitting) return
    setFormError('')
    if (!formData.branchId) return setFormError('Выберите филиал')
    if (!formData.coachName) return setFormError('Выберите тренера')
    if (!isValidDateOnly(formData.date)) return setFormError('Выберите корректную дату')

    const timeStr = parseTimeToHHMM(formData.time)
    if (timeStr === '--:--') return setFormError('Введите время в формате ЧЧ:ММ')

    const [year, month, day] = formData.date.split('-').map(Number)
    const dayOfWeek = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][new Date(year, month - 1, day).getDay()]

    setIsSubmitting(true)
    try {
      await store.createLesson({
        branchId: formData.branchId,
        date: formData.date,
        dayOfWeek,
        time: timeStr,
        title: formData.category === 'синхронное плавание' ? 'Синхронное плавание' : 'Плавание',
        coachName: formData.coachName,
        category: formData.category,
        pool: 'Основной бассейн',
        duration: '1 час',
        maxCapacity: 10,
        isRecurring: false,
        clientId: formData.clientId || undefined,
      } as any)

      onClose()
      setClientOptions([])
      setFormData({
        date: today(),
        time: '17:00',
        coachName: store.branchCoaches[0]?.name || '',
        clientId: '',
        branchId: defaultBranchId,
        category: 'плавание',
      })
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Не удалось создать занятие')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !isSubmitting) onClose()
      }}
    >
      <DialogContent className="max-w-[460px] overflow-hidden rounded-[28px] border-0 bg-slate-50 p-0 shadow-2xl">
        <div className="bg-gradient-to-br from-cyan-600 to-sky-700 px-6 py-6 text-white">
          <DialogHeader>
            <div className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-white/15">
              <CalendarPlus className="size-5" />
            </div>
            <DialogTitle className="text-2xl font-bold text-white">Новое занятие</DialogTitle>
            <p className="mt-1 text-sm text-cyan-50">Добавьте занятие в расписание филиала</p>
          </DialogHeader>
        </div>
        <div className="grid gap-4 p-6">
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              <span className="flex items-center gap-1.5">
                <CalendarPlus className="size-3.5 text-cyan-600" />
                Дата
              </span>
              <Input
                type="date"
                value={formData.date}
                onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                className="h-11 rounded-xl bg-white"
                disabled={isSubmitting}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              <span className="flex items-center gap-1.5">
                <Clock3 className="size-3.5 text-cyan-600" />
                Время
              </span>
              <Select
                value={formData.time}
                disabled={isSubmitting}
                onValueChange={(time) => time && setFormData({ ...formData, time })}
              >
                <SelectTrigger className="h-11 w-full rounded-xl bg-white">
                  <SelectValue placeholder="Выберите время" />
                </SelectTrigger>
                <SelectContent className="max-h-72 rounded-xl bg-white">
                  {LESSON_TIME_OPTIONS.map((time) => (
                    <SelectItem key={time} value={time}>
                      {time}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            <span>Филиал</span>
            <select
              value={formData.branchId}
              onChange={(event) => {
                const branchId = event.target.value
                const firstCoach = store.coaches.find((coach) => String(coach.branchId) === branchId)
                setFormData({ ...formData, branchId, coachName: firstCoach?.name || '', clientId: '' })
                setClientOptions([])
              }}
              disabled={isSubmitting}
              className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 outline-none transition focus:border-cyan-500 focus:ring-4 focus:ring-cyan-100"
            >
              <option value="">Выберите филиал</option>
              {store.branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>

          <Select
            value={formData.category}
            disabled={isSubmitting}
            onValueChange={(val) => {
              if (val === 'плавание' || val === 'синхронное плавание') {
                setFormData({ ...formData, category: val, clientId: '' })
              }
            }}
          >
            <SelectTrigger className="h-11 w-full rounded-xl bg-white">
              <SelectValue placeholder="Секция" />
            </SelectTrigger>
            <SelectContent className="rounded-xl bg-white">
              <SelectItem value="плавание">🏊 Плавание</SelectItem>
              <SelectItem value="синхронное плавание">🎭 Синхронное плавание</SelectItem>
            </SelectContent>
          </Select>

          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            <span className="flex items-center gap-1.5">
              <UserRound className="size-3.5 text-cyan-600" />
              Тренер
            </span>
            <Select
              value={formData.coachName}
              disabled={isSubmitting}
              onValueChange={(val) => val && setFormData({ ...formData, coachName: val })}
            >
              <SelectTrigger className="h-11 w-full rounded-xl bg-white">
                <SelectValue placeholder="Тренер" />
              </SelectTrigger>
              <SelectContent className="rounded-xl bg-white">
                {availableCoaches.map((c) => (
                  <SelectItem key={c.id} value={c.name}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            <span className="flex items-center gap-1.5">
              <UserRound className="size-3.5 text-cyan-600" />
              Клиент <em className="font-normal text-slate-400">необязательно</em>
            </span>
            <Select
              value={formData.clientId || '__none__'}
              disabled={isSubmitting}
              onValueChange={(val) => {
                const clientId = val === '__none__' ? '' : (val ?? '')
                setFormData({ ...formData, clientId })
              }}
            >
              <SelectTrigger className="h-11 w-full rounded-xl bg-white" disabled={clientsLoading}>
                <SelectValue placeholder={clientsLoading ? 'Загружаем клиентов…' : 'Выберите клиента'}>
                  {selectedClient
                    ? `${selectedClient.childName}${selectedClient.parentName ? ` · ${selectedClient.parentName}` : ''}`
                    : 'Без привязки к клиенту'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="rounded-xl bg-white">
                <SelectItem value="__none__">Без привязки к клиенту</SelectItem>
                {clientOptions.map((client) => (
                  <SelectItem key={client.id} value={client.id}>
                    {client.childName}
                    {client.parentName ? ' · ' + client.parentName : ''}
                    {client.category ? ' — ' + client.category : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedClient && (
              <div className="mt-1 flex items-center justify-between gap-3 rounded-xl border border-cyan-100 bg-cyan-50/70 px-3 py-2.5 text-xs">
                <span className="flex min-w-0 items-center gap-2 font-medium text-cyan-950">
                  <UsersRound className="size-4 shrink-0 text-cyan-600" />
                  <span className="truncate">
                    {selectedClient.category === 'синхронное плавание' ? 'Синхронное плавание' : 'Плавание'}
                  </span>
                </span>
                <span className="shrink-0 text-slate-600">Осталось: {selectedClient.remainingLessons}</span>
              </div>
            )}
            {!clientsLoading && clientOptions.length === 0 && (
              <span className="text-xs font-normal text-slate-500">
                В этом филиале нет активных клиентов для выбранного вида занятия
              </span>
            )}
          </label>

          {formError && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{formError}</p>}

          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || clientsLoading}
            className="mt-1 h-12 w-full rounded-xl bg-cyan-600 text-white font-bold shadow-lg shadow-cyan-200 hover:bg-cyan-700"
          >
            {isSubmitting ? (
              <>
                <LoaderCircle className="size-4 animate-spin" /> Сохраняем…
              </>
            ) : formData.clientId ? (
              'Создать и записать клиента'
            ) : (
              'Создать занятие'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
})
