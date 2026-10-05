'use client'

import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { CalendarPlus, Clock3, LoaderCircle, UserRound, UsersRound } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useStore } from '@/store/StoreProvider'
import { isValidDateOnly, parseTimeToHHMM } from '@/lib/utils/date'
import { apiClient, ApiError, type ClientOption } from '@/lib/api-client'
import { trainerOptions } from '@/lib/trainer-options'

const LESSON_TIME_OPTIONS = Array.from({ length: 36 }, (_, index) => {
  const minutes = 6 * 60 + index * 30
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
})
const futureTimes = (date: string, now = new Date()) =>
  LESSON_TIME_OPTIONS.filter((time) => new Date(`${date}T${time}:00`).getTime() > now.getTime())

export const CreateLessonModal = observer(({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
  const store = useStore()
  const today = () => {
    const date = new Date()
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const defaultBranchId = store.selectedBranchId || (store.branches.length === 1 ? String(store.branches[0].id) : '')
  const [formData, setFormData] = useState({
    date: today(),
    time: futureTimes(today())[0] || '',
    coachKey: '',
    clientIds: [] as string[],
    branchId: defaultBranchId,
    category: 'плавание' as 'плавание' | 'синхронное плавание',
  })
  const [formError, setFormError] = useState('')
  const [clock, setClock] = useState(() => new Date())
  useEffect(() => {
    if (!isOpen) return
    setClock(new Date())
    const timer = setInterval(() => setClock(new Date()), 30000)
    return () => clearInterval(timer)
  }, [isOpen])
  const availableTimes = futureTimes(formData.date, clock)
  useEffect(() => {
    const times = futureTimes(formData.date, clock)
    if (isOpen && !times.includes(formData.time)) setFormData((previous) => ({ ...previous, time: times[0] || '' }))
  }, [isOpen, formData.date, formData.time, clock])
  const [clientOptions, setClientOptions] = useState<ClientOption[]>([])
  const [clientsLoading, setClientsLoading] = useState(false)
  const [clientSearchRequested, setClientSearchRequested] = useState(false)
  const [clientSearchVersion, setClientSearchVersion] = useState(0)
  const [clientOptionsError, setClientOptionsError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const submitInFlight = useRef(false)
  const [clientQuery, setClientQuery] = useState('')
  const visibleClients = clientOptions.filter((client) =>
    `${client.childName} ${client.parentName}`.toLowerCase().includes(clientQuery.trim().toLowerCase()),
  )
  const [trainersLoading, setTrainersLoading] = useState(false)
  const [trainersError, setTrainersError] = useState('')
  const [trainersRefresh, setTrainersRefresh] = useState(0)
  const availableCoaches = trainerOptions(store.coaches.slice(), store.currentCoachAccounts || [], formData.branchId)
  const selectedCoach = availableCoaches.find((coach) => coach.value === formData.coachKey)

  useEffect(() => {
    if (!isOpen || !store.authStore.isAdmin || (store.hasLoadedCoachAccounts && !trainersRefresh)) {
      setTrainersLoading(false)
      return
    }
    let cancelled = false
    const version = store.authStore.sessionVersion
    setTrainersLoading(true)
    setTrainersError('')
    void apiClient
      .fetchUsers()
      .then((accounts) => {
        if (!cancelled && store.authStore.isAdmin && store.authStore.sessionVersion === version)
          store.rememberCoachAccounts?.(accounts)
      })
      .catch((error) => {
        if (cancelled || store.authStore.sessionVersion !== version) return
        if (error instanceof ApiError && error.status === 401) {
          store.authStore.expireSession()
          return
        }
        setTrainersError('Не удалось загрузить полный список тренеров')
      })
      .finally(() => {
        if (!cancelled) setTrainersLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, trainersRefresh, store, store.authStore.sessionVersion])

  useEffect(() => {
    if (!isOpen || !formData.branchId || !clientSearchRequested) {
      setClientOptions([])
      setClientsLoading(false)
      return
    }
    const controller = new AbortController()
    setClientOptions([])
    setClientOptionsError('')
    setClientsLoading(true)
    void apiClient
      .searchClientOptions('', controller.signal, formData.branchId, 500, formData.category)
      .then((options) => {
        if (!controller.signal.aborted) setClientOptions(options)
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setClientOptions([])
          setClientOptionsError('Не удалось загрузить клиентов. Закройте и откройте список для повторной попытки.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setClientsLoading(false)
      })
    return () => {
      controller.abort()
    }
  }, [formData.branchId, formData.category, isOpen, clientSearchRequested, clientSearchVersion])

  const handleSubmit = async () => {
    if (submitInFlight.current) return
    setFormError('')
    if (!formData.branchId) return setFormError('Выберите филиал')
    if (!selectedCoach) return setFormError('Выберите тренера из списка выбранного филиала')
    if (!isValidDateOnly(formData.date)) return setFormError('Выберите корректную дату')

    const timeStr = parseTimeToHHMM(formData.time)
    if (timeStr === '--:--') return setFormError('Введите время в формате ЧЧ:ММ')
    if (new Date(`${formData.date}T${timeStr}:00`).getTime() <= Date.now())
      return setFormError('Время занятия уже прошло. Выберите будущую дату и время.')

    const [year, month, day] = formData.date.split('-').map(Number)
    const dayOfWeek = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][new Date(year, month - 1, day).getDay()]

    submitInFlight.current = true
    setIsSubmitting(true)
    try {
      await store.createLesson({
        branchId: formData.branchId,
        date: formData.date,
        dayOfWeek,
        time: timeStr,
        title: formData.category === 'синхронное плавание' ? 'Синхронное плавание' : 'Плавание',
        coachName: selectedCoach.name,
        category: formData.category,
        pool: 'Основной бассейн',
        duration: '1 час',
        maxCapacity: Math.max(10, formData.clientIds.length),
        isRecurring: false,
        clientIds: formData.clientIds,
      } as any)

      onClose()
      setClientOptions([])
      setFormData({
        date: today(),
        time: futureTimes(today())[0] || '',
        coachKey: '',
        clientIds: [],
        branchId: defaultBranchId,
        category: 'плавание',
      })
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Не удалось создать занятие')
    } finally {
      submitInFlight.current = false
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
      <DialogContent className="max-w-[560px] overflow-y-auto rounded-[28px] border-0 bg-slate-50 p-0 shadow-2xl">
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
                min={today()}
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
                value={formData.time || null}
                disabled={isSubmitting}
                onValueChange={(time) => time && setFormData({ ...formData, time })}
              >
                <SelectTrigger className="h-11 w-full rounded-xl bg-white">
                  <SelectValue placeholder="Выберите время" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} align="start" className="max-h-72 rounded-xl bg-white">
                  {availableTimes.map((time) => (
                    <SelectItem key={time} value={time}>
                      {time}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!availableTimes.length && (
                <span className="text-xs text-amber-700">Нет доступного времени. Выберите другой день.</span>
              )}
            </label>
          </div>

          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            <span>Филиал</span>
            <select
              value={formData.branchId}
              onChange={(event) => {
                const branchId = event.target.value
                setFormData({ ...formData, branchId, coachKey: '', clientIds: [] })
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
                setFormData({ ...formData, category: val, clientIds: [] })
                setClientOptions([])
              }
            }}
          >
            <SelectTrigger className="h-11 w-full rounded-xl bg-white">
              <SelectValue placeholder="Секция" />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="start" className="rounded-xl bg-white">
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
              items={availableCoaches}
              value={selectedCoach?.value || null}
              disabled={isSubmitting}
              onValueChange={(val) => val && setFormData({ ...formData, coachKey: val })}
            >
              <SelectTrigger
                aria-label="Тренер занятия"
                className="w-full min-w-0 rounded-xl bg-white data-[size=default]:h-11"
              >
                <SelectValue className="min-w-0 truncate" placeholder="Выберите тренера" />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} align="start" className="rounded-xl bg-white">
                {availableCoaches.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {trainersLoading && (
              <span role="status" className="text-xs text-slate-500">
                Загружаем полный список тренеров…
              </span>
            )}
            {trainersError && (
              <span role="alert" className="text-xs text-rose-700">
                {trainersError}
                <button
                  type="button"
                  className="ml-2 underline"
                  onClick={() => setTrainersRefresh((value) => value + 1)}
                >
                  Повторить
                </button>
              </span>
            )}
            {!trainersLoading && !trainersError && formData.branchId && availableCoaches.length === 0 && (
              <span className="text-xs text-slate-500">В этом филиале нет тренеров для выбора</span>
            )}
          </label>

          {store.authStore.isAdmin && (
            <section
              className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4"
              aria-label="Клиенты занятия"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <UsersRound className="size-4 text-cyan-600" />
                  Клиенты занятия
                </h3>
                <span className="text-xs text-cyan-700">Выбрано: {formData.clientIds.length}</span>
              </div>
              <p className="text-xs text-slate-500">
                Отметьте клиентов для записи. Можно создать занятие без клиентов.
              </p>
              {!clientSearchRequested && (
                <Button
                  variant="outline"
                  disabled={!formData.branchId || isSubmitting}
                  onClick={() => setClientSearchRequested(true)}
                >
                  Выбрать клиентов
                </Button>
              )}
              {clientSearchRequested && (
                <>
                  <Input
                    aria-label="Поиск клиентов занятия"
                    placeholder="Поиск по имени или родителю"
                    value={clientQuery}
                    disabled={isSubmitting}
                    onChange={(event) => setClientQuery(event.target.value)}
                  />
                  {clientsLoading && (
                    <p role="status" className="text-xs text-slate-500">
                      Загружаем клиентов…
                    </p>
                  )}
                  {clientOptionsError && (
                    <div role="alert" className="text-xs text-rose-700">
                      <p>{clientOptionsError}</p>
                      <button
                        type="button"
                        className="mt-2 underline"
                        onClick={() => setClientSearchVersion((value) => value + 1)}
                      >
                        Повторить загрузку клиентов
                      </button>
                    </div>
                  )}
                  {!clientsLoading && !clientOptionsError && (
                    <>
                      <div className="flex gap-3 text-xs">
                        <button
                          type="button"
                          disabled={isSubmitting}
                          className="text-cyan-700"
                          onClick={() =>
                            setFormData((current) => ({
                              ...current,
                              clientIds: Array.from(
                                new Set([...current.clientIds, ...visibleClients.map((client) => client.id)]),
                              ).slice(0, 100),
                            }))
                          }
                        >
                          Выбрать найденных
                        </button>
                        <button
                          type="button"
                          disabled={isSubmitting}
                          className="text-slate-500"
                          onClick={() => setFormData((current) => ({ ...current, clientIds: [] }))}
                        >
                          Снять выбор
                        </button>
                      </div>
                      <div className="max-h-56 overflow-y-auto divide-y divide-slate-100">
                        {visibleClients.map((client) => (
                          <label key={client.id} className="flex cursor-pointer items-center gap-3 py-3">
                            <input
                              type="checkbox"
                              aria-label={'Записать ' + client.childName}
                              checked={formData.clientIds.includes(client.id)}
                              disabled={
                                isSubmitting ||
                                (!formData.clientIds.includes(client.id) && formData.clientIds.length >= 100)
                              }
                              className="size-4 shrink-0 accent-cyan-700"
                              onChange={(event) =>
                                setFormData((current) => ({
                                  ...current,
                                  clientIds: event.target.checked
                                    ? [...current.clientIds.filter((id) => id !== client.id), client.id]
                                    : current.clientIds.filter((id) => id !== client.id),
                                }))
                              }
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium text-slate-800">{client.childName}</span>
                              <span className="block text-xs text-slate-500">{client.parentName}</span>
                            </span>
                            <span className="text-xs text-slate-500">{client.remainingLessons} занятий</span>
                          </label>
                        ))}
                      </div>
                      {visibleClients.length === 0 && clientOptions.length > 0 && (
                        <p className="text-xs text-slate-500">По этому запросу клиентов нет</p>
                      )}
                      <p className="text-xs text-slate-500">До 100 клиентов за одно сохранение.</p>
                    </>
                  )}
                </>
              )}
              {clientSearchRequested && !clientOptionsError && !clientsLoading && clientOptions.length === 0 && (
                <span className="text-xs font-normal text-slate-500">
                  В этом филиале нет активных клиентов для выбранного вида занятия
                </span>
              )}
            </section>
          )}

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
            ) : formData.clientIds.length ? (
              `Создать и записать (${formData.clientIds.length})`
            ) : (
              'Создать занятие'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
})
