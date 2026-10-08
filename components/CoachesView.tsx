'use client'

import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { getStore } from '@/store/RootStore'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { CalendarDays, KeyRound, Link2, Phone, Plus, RefreshCw, Trash2, UserRoundCheck } from 'lucide-react'
import { apiClient, ApiError, CoachAccount } from '@/lib/api-client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatBirthDate, formatPhone } from '@/lib/formatters'

const store = getStore()
const emptyCoachForm = {
  name: '',
  surname: '',
  phone: '',
  birthDate: '',
  branchId: '',
  username: '',
  password: '',
}

const branchLabel = (branchId: string | null) => {
  const branch = store.branches.find((item) => String(item.id) === String(branchId || ''))
  return branch?.name ?? 'Филиал не назначен'
}

export const CoachesView = observer(() => {
  const coaches = store.branchCoaches
  const sessionVersion = store.authStore.sessionVersion
  const [isAddCoachOpen, setIsAddCoachOpen] = useState(false)
  const [formData, setFormData] = useState(emptyCoachForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<CoachAccount[]>(() => store.currentCoachAccounts || [])
  const [assigningBranches, setAssigningBranches] = useState<Record<string, string>>({})
  const [linkingAccounts, setLinkingAccounts] = useState<Record<string, string>>({})
  const [passwords, setPasswords] = useState<Record<string, string>>({})
  const [accountsError, setAccountsError] = useState<string | null>(null)
  const [accountsNotice, setAccountsNotice] = useState<string | null>(null)
  const [accountsLoading, setAccountsLoading] = useState(true)
  const [registrationLink, setRegistrationLink] = useState('')
  const [sharingNotice, setSharingNotice] = useState('')
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const actionInFlight = useRef(false)
  const mounted = useRef(true)
  const accountsRead = useRef<Promise<void> | null>(null)

  const linkedUserIds = new Set(store.coaches.map((coach) => coach.userId).filter(Boolean))
  const branchItems = store.branches.map((branch) => ({ value: String(branch.id), label: branch.name }))
  const visibleAccounts = accounts.filter(
    (account) =>
      store.authStore.isAdmin &&
      (!store.selectedBranchId || !account.branchId || account.branchId === store.selectedBranchId),
  )
  const pendingAccounts = visibleAccounts.filter((account) => account.status === 'Ожидает подтверждения')
  const trainerAccounts = visibleAccounts.filter((account) => account.status !== 'Ожидает подтверждения')
  // Join only by explicit userId; names are not an identity key.
  const standaloneCoaches = coaches.filter(
    (coach) => !store.authStore.isAdmin || !accounts.some((account) => account.id === coach.userId),
  )
  const controlsBusy = busyAccountId !== null || isCreating || accountsLoading

  const copyRegistrationLink = async () => {
    const link = window.location.origin + '/register'
    setRegistrationLink(link)
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(link)
      setSharingNotice('Ссылка скопирована.')
    } catch {
      setSharingNotice('Не удалось скопировать автоматически. Выделите и скопируйте ссылку из поля.')
    }
  }

  const loadAccounts = (): Promise<void> => {
    if (accountsRead.current) return accountsRead.current
    const version = store.authStore.sessionVersion
    setAccountsLoading(true)
    const currentRead = (async () => {
      try {
        const users = await apiClient.fetchUsers()
        if (
          !Array.isArray(users) ||
          users.some(
            (user) =>
              !user ||
              typeof user.id !== 'string' ||
              !user.id.trim() ||
              typeof user.username !== 'string' ||
              !user.username.trim() ||
              user.role !== 'coach' ||
              !['Активен', 'Отключен', 'Ожидает подтверждения'].includes(user.status) ||
              (user.branchId !== null && typeof user.branchId !== 'string'),
          )
        )
          throw new Error('Invalid accounts response')
        if (!mounted.current || !store.authStore.isAdmin || version !== store.authStore.sessionVersion) return
        setAccounts(users)
        store.rememberCoachAccounts?.(users)
        setAccountsError(null)
      } catch (error) {
        if (!mounted.current || version !== store.authStore.sessionVersion) return
        if (error instanceof ApiError && error.status === 401) {
          store.authStore.expireSession()
          return
        }
        setAccountsError(
          error instanceof ApiError ? error.message : 'Не удалось загрузить аккаунты. Нажмите «Обновить список».',
        )
      } finally {
        if (mounted.current && version === store.authStore.sessionVersion) setAccountsLoading(false)
      }
    })().finally(() => {
      if (accountsRead.current === currentRead) accountsRead.current = null
    })
    accountsRead.current = currentRead
    return currentRead
  }

  useEffect(() => {
    mounted.current = true
    setAccounts(store.currentCoachAccounts || [])
    setAccountsError(null)
    setAccountsNotice(null)
    setAssigningBranches({})
    setLinkingAccounts({})
    setPasswords({})
    if (store.authStore.isAdmin && !store.hasLoadedCoachAccounts) void loadAccounts()
    else setAccountsLoading(false)
    return () => {
      mounted.current = false
      accountsRead.current = null
    }
  }, [sessionVersion])

  const confirmed = (result: { success: boolean }) => {
    if (!result || result.success !== true)
      throw new ApiError(502, { message: 'Сервис не подтвердил изменение. Обновите список перед повтором.' })
  }

  const runAccountAction = async (userId: string, action: () => Promise<void>) => {
    // React may not have rendered the disabled state before a second click.
    if (actionInFlight.current || accountsRead.current || !store.authStore.isAdmin) return
    actionInFlight.current = true
    setBusyAccountId(userId)
    setAccountsError(null)
    setAccountsNotice(null)
    try {
      await action()
    } catch (error) {
      await loadAccounts()
      if (mounted.current)
        setAccountsError(
          error instanceof ApiError
            ? error.message
            : 'Изменение не подтверждено. Проверьте статус в списке перед повтором.',
        )
    } finally {
      actionInFlight.current = false
      if (mounted.current) setBusyAccountId(null)
    }
  }

  const handleAddDialogChange = (open: boolean) => {
    setIsAddCoachOpen(open)
    if (!open) return
    setFormError(null)
    setFormData({
      ...emptyCoachForm,
      branchId: store.selectedBranchId || (store.branches.length === 1 ? String(store.branches[0].id) : ''),
    })
  }

  const assignBranch = async (userId: string) => {
    const account = accounts.find((item) => item.id === userId)
    const branchId = assigningBranches[userId] || account?.branchId || ''
    if (!branchItems.some((branch) => branch.value === branchId)) {
      setAccountsError('Выберите филиал для аккаунта тренера')
      return
    }
    await runAccountAction(userId, async () => {
      confirmed(await apiClient.assignUserBranch(userId, branchId))
      setAccounts((current) => current.map((item) => (item.id === userId ? { ...item, branchId } : item)))
      setAccountsNotice('Филиал сохранён.')
      await loadAccounts()
    })
  }

  const changeAccountStatus = async (account: CoachAccount) => {
    const branchId = assigningBranches[account.id] || account.branchId || ''
    if (account.status !== 'Активен' && !branchItems.some((branch) => branch.value === branchId)) {
      setAccountsError('Выберите филиал, в котором тренер будет работать.')
      return
    }
    if (
      account.status === 'Активен' &&
      !window.confirm('Отключить вход для «' + account.username + '»? Карточка и история сохранятся.')
    )
      return
    await runAccountAction(account.id, async () => {
      if (account.status === 'Активен') confirmed(await apiClient.deactivateUser(account.id))
      else {
        // Only activate after the branch assignment is confirmed. An interrupted
        // second step leaves a pending account pending; it never grants access.
        if (branchId !== account.branchId) {
          confirmed(await apiClient.assignUserBranch(account.id, branchId))
          setAccounts((current) => current.map((item) => (item.id === account.id ? { ...item, branchId } : item)))
        }
        confirmed(await apiClient.activateUser(account.id))
      }
      setAccounts((current) =>
        current.map((item) =>
          item.id === account.id
            ? {
                ...item,
                status: account.status === 'Активен' ? 'Отключен' : 'Активен',
                branchId: account.status === 'Активен' ? item.branchId : branchId,
              }
            : item,
        ),
      )
      setAccountsNotice(
        account.status === 'Активен'
          ? 'Вход отключён.'
          : 'Доступ подтверждён. Тренер может войти со своим логином и паролем.',
      )
      await loadAccounts()
    })
  }

  const resetPassword = async (userId: string) => {
    const newPassword = passwords[userId] || ''
    if (newPassword.length < 8) {
      setAccountsError('Временный пароль должен содержать не менее 8 символов')
      return
    }
    if (newPassword.length > 200) {
      setAccountsError('Пароль должен содержать не более 200 символов')
      return
    }
    await runAccountAction(userId, async () => {
      confirmed(await apiClient.resetCoachPassword(userId, newPassword))
      setPasswords((current) => ({ ...current, [userId]: '' }))
      setAccountsNotice('Пароль изменён. Передайте новый пароль тренеру по защищённому каналу.')
    })
  }

  const linkAccount = async (coachId: string) => {
    const coach = store.coaches.find((item) => String(item.id) === coachId)
    const eligible = accounts.filter(
      (account) =>
        account.branchId === String(coach?.branchId) &&
        (!linkedUserIds.has(account.id) || account.id === coach?.userId),
    )
    const userId = linkingAccounts[coachId] || (eligible.length === 1 ? eligible[0].id : '')
    if (!userId || !eligible.some((account) => account.id === userId)) {
      setAccountsError('Выберите аккаунт для связи с карточкой тренера')
      return
    }
    await runAccountAction(userId, async () => {
      confirmed(await apiClient.linkCoachUser(coachId, userId))
      await store.initialize(true)
      await loadAccounts()
      setLinkingAccounts((current) => ({ ...current, [coachId]: '' }))
      setAccountsNotice('Записи объединены. Тренер отображается в списке один раз.')
    })
  }

  const deleteCoach = async (coachId: string, coachName: string) => {
    if (
      !window.confirm(
        'Удалить сведения о тренере «' + coachName + '»? Его вход будет отключён. Учётная запись и история сохранятся.',
      )
    )
      return
    await runAccountAction('coach:' + coachId, async () => {
      await store.deleteCoach(coachId)
      await loadAccounts()
      setAccountsNotice('Сведения удалены. Связанный вход отключён; учётная запись и история сохранены.')
    })
  }

  const handleSubmit = async () => {
    if (actionInFlight.current || accountsRead.current || !store.authStore.isAdmin) return
    setFormError(null)
    const fullName = (formData.name + ' ' + formData.surname).trim()
    if (!fullName) {
      setFormError('Укажите имя и фамилию тренера')
      return
    }
    if (!formData.branchId) {
      setFormError('Выберите филиал тренера')
      return
    }
    if (formData.phone && formData.phone.replace(/\D/g, '').length < 11) {
      setFormError('Введите полный номер телефона тренера')
      return
    }
    if (formData.birthDate && !/^\d{2}\.\d{2}\.\d{4}$/.test(formData.birthDate)) {
      setFormError('Дата рождения должна быть в формате ДД.ММ.ГГГГ')
      return
    }
    if ((formData.username && !formData.password) || (!formData.username && formData.password)) {
      setFormError('Для создания доступа укажите и логин, и пароль')
      return
    }
    if (formData.password && formData.password.length < 8) {
      setFormError('Временный пароль должен содержать не менее 8 символов')
      return
    }
    actionInFlight.current = true
    setIsCreating(true)
    try {
      await store.createCoach({
        name: fullName,
        specialty: 'Тренер',
        branchId: formData.branchId,
        phone: formData.phone,
        birthDate: formData.birthDate,
        ...(formData.username ? { username: formData.username, password: formData.password } : {}),
      })
      setIsAddCoachOpen(false)
      setFormData(emptyCoachForm)
      // A profile-only creation does not change Users. The confirmed profile
      // is already in the store; only refresh accounts when one was created.
      if (formData.username) await loadAccounts()
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Не удалось создать тренера')
    } finally {
      actionInFlight.current = false
      setIsCreating(false)
    }
  }

  const renderAccount = (account: CoachAccount) => {
    const selectedBranch = assigningBranches[account.id] || account.branchId || ''
    const validBranch = branchItems.some((branch) => branch.value === selectedBranch)
    const pending = account.status === 'Ожидает подтверждения'
    const active = account.status === 'Активен'
    const linkedCoach = store.coaches.find((coach) => coach.userId === account.id)
    const management = (
      <>
        <div className="grid min-w-0 gap-3">
          <label htmlFor={'account-branch-' + account.id} className="text-xs font-medium text-slate-600">
            Филиал для работы
          </label>
          <Select
            items={branchItems}
            value={selectedBranch || null}
            disabled={controlsBusy || branchItems.length === 0}
            onValueChange={(value) => value && setAssigningBranches((current) => ({ ...current, [account.id]: value }))}
          >
            <SelectTrigger
              id={'account-branch-' + account.id}
              className="w-full min-w-0 rounded-lg data-[size=default]:h-10"
              aria-label={'Филиал для ' + account.username}
            >
              <SelectValue className="min-w-0 truncate" placeholder="Выберите филиал">
                {(value) => (value ? branchLabel(String(value)) : 'Выберите филиал')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="start">
              {store.branches.map((branch) => (
                <SelectItem key={branch.id} value={String(branch.id)}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {branchItems.length === 0 && (
            <p className="text-xs text-amber-800">Сначала добавьте филиал в настройках филиалов.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {active && (
              <Button
                variant="outline"
                size="sm"
                disabled={controlsBusy || !validBranch || selectedBranch === account.branchId}
                onClick={() => void assignBranch(account.id)}
              >
                Сохранить филиал
              </Button>
            )}
            <Button
              variant={account.status === 'Активен' ? 'destructive' : 'default'}
              size="sm"
              disabled={controlsBusy || account.profileArchived || (!active && !validBranch)}
              onClick={() => void changeAccountStatus(account)}
            >
              <UserRoundCheck className="mr-1 size-3.5" />{' '}
              {busyAccountId === account.id
                ? 'Сохраняем…'
                : active
                  ? 'Отключить вход'
                  : pending
                    ? 'Подтвердить доступ'
                    : 'Разрешить вход'}
            </Button>
            {active && account.canRevokeSessions && (
              <Button
                variant="outline"
                size="sm"
                disabled={controlsBusy}
                onClick={() => {
                  if (
                    !window.confirm(
                      'Завершить все сессии «' + account.username + '»? Для нового входа потребуется пароль.',
                    )
                  )
                    return
                  void runAccountAction(account.id, async () => {
                    confirmed(await apiClient.revokeUserSessions(account.id))
                    setAccountsNotice('Все сессии тренера завершены. Аккаунт остаётся активным.')
                    await loadAccounts()
                  })
                }}
              >
                Завершить сессии
              </Button>
            )}
          </div>
          {!active && !validBranch && <p className="text-xs text-slate-500">Выберите филиал, чтобы разрешить вход.</p>}
          {account.profileArchived && (
            <p className="text-xs text-slate-500">
              Карточка тренера архивирована. Вход отключён; повторная активация требует отдельного восстановления
              карточки.
            </p>
          )}
        </div>
        <details
          className={pending ? 'border-t border-slate-100 pt-3 md:col-span-2' : 'border-t border-slate-100 pt-3'}
        >
          <summary className="w-fit cursor-pointer text-sm text-slate-600">Изменить пароль</summary>
          <p className="my-3 text-xs text-slate-500">
            Только если тренер забыл пароль. При подтверждении регистрации менять его не нужно.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="password"
              value={passwords[account.id] || ''}
              onChange={(event) => setPasswords((current) => ({ ...current, [account.id]: event.target.value }))}
              aria-label={'Новый пароль для ' + account.username}
              autoComplete="new-password"
              maxLength={200}
              disabled={controlsBusy}
              placeholder="Новый пароль: от 8 символов"
              className="h-9 rounded-lg"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={controlsBusy || (passwords[account.id] || '').length < 8}
              onClick={() => void resetPassword(account.id)}
            >
              <KeyRound className="mr-1 size-3.5" /> Изменить пароль
            </Button>
          </div>
        </details>
        {!pending && linkedCoach && (
          <Button
            variant="ghost"
            size="sm"
            className="w-fit text-rose-600"
            disabled={controlsBusy}
            onClick={() => void deleteCoach(linkedCoach.id, linkedCoach.name)}
          >
            <Trash2 className="mr-1 size-3.5" /> Удалить сведения
          </Button>
        )}
      </>
    )
    return (
      <div
        key={account.id}
        data-trainer-id={account.id}
        className={
          pending
            ? 'grid min-w-0 gap-4 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-[minmax(0,1fr)_minmax(240px,1fr)]'
            : 'grid min-w-0 content-start gap-4 rounded-2xl border border-slate-200 bg-white p-6'
        }
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="break-all font-semibold text-slate-900">{linkedCoach?.name || account.username}</p>
            <span
              className={
                pending
                  ? 'rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-800'
                  : active
                    ? 'rounded-full bg-emerald-50 px-2 py-1 text-xs text-emerald-800'
                    : 'rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600'
              }
            >
              {pending ? 'Новая заявка' : active ? 'Вход разрешён' : 'Вход отключён'}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-600">{branchLabel(account.branchId)}</p>
          <p className="mt-1 text-xs text-slate-500">Логин: {account.username}</p>
          {!pending && (
            <div className="mt-4 grid gap-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
              <p>Специализация: {linkedCoach?.specialty || 'Не указана'}</p>
              <p className="flex items-center gap-2">
                <Phone className="size-3.5" />
                {linkedCoach?.phone || 'Телефон не указан'}
              </p>
              <p className="flex items-center gap-2">
                <CalendarDays className="size-3.5" />
                Дата рождения: {linkedCoach?.birthDate || 'Не указана'}
              </p>
              <p>
                Записей в расписании:{' '}
                {
                  store.sortedBranchLessons.filter(
                    (lesson) =>
                      String(lesson.branchId) === account.branchId &&
                      lesson.coachName === (linkedCoach?.name || account.username),
                  ).length
                }
              </p>
            </div>
          )}
        </div>
        {pending ? (
          management
        ) : (
          <details className="min-w-0 border-t border-slate-100 pt-3">
            <summary className="w-fit cursor-pointer text-sm text-cyan-800">Управление тренером</summary>
            <div className="mt-4 grid min-w-0 gap-4">{management}</div>
          </details>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap justify-between items-center gap-4 bg-white p-6 rounded-3xl border border-slate-200/80">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Тренеры</h2>
          <p className="mt-1 text-sm text-slate-500">Подтвердите новых тренеров и управляйте входом в CRM.</p>
        </div>
        {store.authStore.isAdmin && (
          <Dialog open={isAddCoachOpen} onOpenChange={handleAddDialogChange}>
            <DialogTrigger
              render={
                <Button disabled={controlsBusy} className="rounded-full bg-cyan-500 hover:bg-cyan-600 text-white" />
              }
            >
              <Plus className="mr-2 size-4" /> Добавить тренера
            </DialogTrigger>
            <DialogContent className="max-w-[450px] p-0 rounded-3xl overflow-hidden border-pink-100 bg-white">
              <DialogHeader className="p-8 border-b border-pink-50 bg-gradient-to-br from-cyan-50 via-white to-pink-50/50">
                <DialogTitle className="text-2xl font-extrabold text-cyan-950 tracking-tight">Новый тренер</DialogTitle>
              </DialogHeader>
              <div className="grid gap-5 p-8">
                {formError && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600">{formError}</p>}
                <Input
                  placeholder="Имя"
                  value={formData.name}
                  onChange={(event) => setFormData({ ...formData, name: event.target.value })}
                  className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
                />
                <Input
                  placeholder="Фамилия"
                  value={formData.surname}
                  onChange={(event) => setFormData({ ...formData, surname: event.target.value })}
                  className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
                />
                <Input
                  inputMode="tel"
                  placeholder="Телефон"
                  value={formData.phone}
                  onChange={(event) => setFormData({ ...formData, phone: formatPhone(event.target.value) })}
                  className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
                />
                <Input
                  inputMode="numeric"
                  placeholder="Дата рождения, ДД.ММ.ГГГГ"
                  value={formData.birthDate}
                  maxLength={10}
                  onChange={(event) => setFormData({ ...formData, birthDate: formatBirthDate(event.target.value) })}
                  className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
                />
                <Select
                  items={branchItems}
                  value={formData.branchId || null}
                  onValueChange={(value) => value && setFormData({ ...formData, branchId: value })}
                >
                  <SelectTrigger
                    className="w-full min-w-0 rounded-xl data-[size=default]:h-12"
                    aria-label="Филиал тренера"
                  >
                    <SelectValue className="min-w-0 truncate" placeholder="Выберите филиал">
                      {(value) => (value ? branchLabel(String(value)) : 'Выберите филиал')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} align="start">
                    {store.branches.map((branch) => (
                      <SelectItem key={branch.id} value={String(branch.id)}>
                        {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!store.selectedBranchId && !formData.branchId && (
                  <p className="-mt-3 text-xs text-amber-700">
                    В режиме «Все филиалы» филиал тренера нужно выбрать явно.
                  </p>
                )}
                <div className="border-t border-slate-100 pt-5">
                  <p className="mb-3 text-sm font-semibold text-slate-800">Доступ в CRM (необязательно)</p>
                  <div className="grid gap-3">
                    <Input
                      placeholder="Логин тренера"
                      value={formData.username}
                      onChange={(event) => setFormData({ ...formData, username: event.target.value })}
                      className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
                    />
                    <Input
                      type="password"
                      placeholder="Временный пароль (минимум 8 символов)"
                      value={formData.password}
                      onChange={(event) => setFormData({ ...formData, password: event.target.value })}
                      className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
                    />
                    <p className="text-xs text-slate-500">
                      Аккаунт создаётся вместе с карточкой тренера и сразу получает выбранный филиал.
                    </p>
                  </div>
                </div>
                <Button
                  onClick={() => void handleSubmit()}
                  disabled={controlsBusy}
                  className="w-full rounded-full bg-cyan-500 hover:bg-cyan-600 text-white font-bold h-12"
                >
                  {isCreating ? 'Сохраняем…' : 'Сохранить'}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {store.authStore.isAdmin && (
        <Card className="rounded-3xl border border-slate-200/80 bg-white ring-0">
          <CardContent className="grid gap-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-900">Пригласить тренера</h3>
                <p className="mt-1 text-sm text-slate-600">
                  Тренер регистрируется по ссылке. Вы подтверждаете его заявку ниже.
                </p>
              </div>
              <Button variant="outline" size="sm" disabled={controlsBusy} onClick={() => void loadAccounts()}>
                <RefreshCw className={accountsLoading ? 'mr-1 size-4 animate-spin' : 'mr-1 size-4'} />
                Обновить список
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-slate-500">
                Отправьте тренеру ссылку на ваш сайт с адресом{' '}
                <Link href="/register" prefetch={false} className="text-cyan-800 underline">
                  /register
                </Link>
                . Пароль он задаст самостоятельно.
              </p>
              <Button variant="outline" size="sm" onClick={() => void copyRegistrationLink()}>
                Скопировать ссылку
              </Button>
            </div>
            {registrationLink && (
              <div className="grid gap-2">
                <Input
                  aria-label="Ссылка для регистрации тренера"
                  readOnly
                  value={registrationLink}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <p role="status" className="text-xs text-slate-600">
                  {sharingNotice}
                </p>
                {/^https?:\/\/(localhost|127\.0\.0\.1)([:/])/.test(registrationLink) && (
                  <p className="text-xs text-amber-800">
                    Это локальная ссылка: на другом компьютере она не откроется. Для тренера нужна ссылка на
                    опубликованный сайт.
                  </p>
                )}
              </div>
            )}
            {accountsError && (
              <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {accountsError}
              </p>
            )}
            {accountsNotice && (
              <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                {accountsNotice}
              </p>
            )}
          </CardContent>
        </Card>
      )}
      {store.authStore.isAdmin && pendingAccounts.length > 0 && (
        <Card className="rounded-3xl border border-amber-200 bg-white ring-0" data-section="pending-coaches">
          <CardContent className="grid gap-4 p-5">
            <h3 className="font-semibold text-slate-900">Новые заявки · {pendingAccounts.length}</h3>
            <p className="text-sm text-slate-600">
              Выберите филиал и подтвердите тренера. После подтверждения он появится в списке «Тренеры».
            </p>
            {pendingAccounts.map(renderAccount)}
          </CardContent>
        </Card>
      )}

      <div>
        <h3 className="mb-4 font-semibold text-slate-900">Тренеры</h3>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {store.authStore.isAdmin && trainerAccounts.map(renderAccount)}
          {standaloneCoaches.length === 0 && trainerAccounts.length === 0 ? (
            <p className="col-span-full py-10 text-center text-slate-500">
              {accountsLoading
                ? 'Загружаем тренеров…'
                : accountsError
                  ? 'Не удалось загрузить всех тренеров. Обновите список.'
                  : pendingAccounts.length
                    ? 'Новые заявки ожидают вашего подтверждения.'
                    : 'В этом филиале пока нет тренеров'}
            </p>
          ) : (
            standaloneCoaches.map((coach) => {
              const linkableAccounts = accounts.filter(
                (account) =>
                  account.branchId === String(coach.branchId) &&
                  (!linkedUserIds.has(account.id) || account.id === coach.userId),
              )
              const selectedAccount =
                linkingAccounts[coach.id] || (linkableAccounts.length === 1 ? linkableAccounts[0].id : '')
              return (
                <Card
                  key={coach.id}
                  className="rounded-3xl border border-slate-200/80 bg-white ring-0 hover:shadow-md transition-shadow"
                >
                  <CardContent className="grid gap-4 p-6">
                    <div className="flex items-center gap-4">
                      <div className="flex size-16 items-center justify-center rounded-full bg-gradient-to-tr from-cyan-100 to-pink-100 text-xl font-bold text-cyan-700">
                        {coach.initials}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="font-bold text-lg text-slate-900">{coach.name}</h3>
                        <p className="text-sm text-slate-500">{coach.specialty}</p>
                        <p className="mt-1 text-xs text-slate-500">{branchLabel(String(coach.branchId))}</p>
                      </div>
                    </div>
                    {(coach.phone || coach.birthDate) && (
                      <div className="grid gap-2 text-sm text-slate-600">
                        {coach.phone && (
                          <p className="flex items-center gap-2">
                            <Phone className="size-4 text-cyan-600" /> {coach.phone}
                          </p>
                        )}
                        {coach.birthDate && (
                          <p className="flex items-center gap-2">
                            <CalendarDays className="size-4 text-cyan-600" /> {coach.birthDate}
                          </p>
                        )}
                      </div>
                    )}
                    <p className="text-xs text-slate-500">
                      Записей в расписании:{' '}
                      {
                        store.sortedBranchLessons.filter(
                          (lesson) =>
                            String(lesson.branchId) === String(coach.branchId) && lesson.coachName === coach.name,
                        ).length
                      }
                    </p>
                    {store.authStore.isAdmin && (
                      <details className="border-t border-slate-100 pt-4">
                        <summary className="w-fit cursor-pointer text-sm text-cyan-800">Управление тренером</summary>
                        <div className="mt-4 grid gap-2">
                          {linkableAccounts.length > 0 ? (
                            <>
                              <p className="text-sm text-slate-600">Объединить с зарегистрированным тренером</p>
                              <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                                <Select
                                  items={linkableAccounts.map((account) => ({
                                    value: account.id,
                                    label: account.username,
                                  }))}
                                  value={selectedAccount || null}
                                  disabled={controlsBusy}
                                  onValueChange={(value) =>
                                    value && setLinkingAccounts((current) => ({ ...current, [coach.id]: value }))
                                  }
                                >
                                  <SelectTrigger
                                    className="w-full min-w-0 flex-1 rounded-lg data-[size=default]:h-10"
                                    aria-label={'Аккаунт для ' + coach.name}
                                  >
                                    <SelectValue className="min-w-0 truncate" placeholder="Выберите логин">
                                      {(value) =>
                                        value
                                          ? linkableAccounts.find((account) => account.id === String(value))
                                              ?.username || 'Логин недоступен'
                                          : 'Выберите логин'
                                      }
                                    </SelectValue>
                                  </SelectTrigger>
                                  <SelectContent alignItemWithTrigger={false} align="start">
                                    {linkableAccounts.map((account) => (
                                      <SelectItem key={account.id} value={account.id}>
                                        {account.username}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={controlsBusy || !selectedAccount}
                                  onClick={() => void linkAccount(coach.id)}
                                >
                                  <Link2 className="mr-1 size-3.5" /> Объединить
                                </Button>
                              </div>
                            </>
                          ) : (
                            <p className="text-sm text-slate-500">
                              {accountsLoading
                                ? 'Проверяем логин…'
                                : accountsError
                                  ? 'Не удалось проверить логин. Обновите список выше.'
                                  : coach.userId
                                    ? 'Связанный логин не найден. Обновите список выше.'
                                    : 'Вход ещё не создан. Отправьте тренеру ссылку на регистрацию. Если он уже зарегистрирован, объедините записи после подтверждения заявки.'}
                            </p>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-fit text-rose-600 hover:text-rose-700"
                            disabled={controlsBusy}
                            onClick={() => void deleteCoach(coach.id, coach.name)}
                          >
                            <Trash2 className="mr-1 size-3.5" /> Удалить карточку
                          </Button>
                        </div>
                      </details>
                    )}
                  </CardContent>
                </Card>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
})
