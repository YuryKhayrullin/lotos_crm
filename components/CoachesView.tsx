'use client'

import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { getStore } from '@/store/RootStore'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { CalendarDays, KeyRound, Link2, Phone, Plus, Trash2, UserRoundCheck } from 'lucide-react'
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
  const [accounts, setAccounts] = useState<CoachAccount[]>([])
  const [assigningBranches, setAssigningBranches] = useState<Record<string, string>>({})
  const [linkingAccounts, setLinkingAccounts] = useState<Record<string, string>>({})
  const [passwords, setPasswords] = useState<Record<string, string>>({})
  const [accountsError, setAccountsError] = useState<string | null>(null)
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  const linkedUserIds = new Set(store.coaches.map((coach) => coach.userId).filter(Boolean))

  const loadAccounts = async () => {
    try {
      const users = await apiClient.fetchUsers()
      setAccounts(users)
      setAccountsError(null)
    } catch (error) {
      setAccountsError(error instanceof ApiError ? error.message : 'Не удалось загрузить аккаунты тренеров')
    }
  }

  useEffect(() => {
    if (store.authStore.isAdmin) void loadAccounts()
  }, [sessionVersion])

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
    if (!branchId) {
      setAccountsError('Выберите филиал для аккаунта тренера')
      return
    }
    setBusyAccountId(userId)
    try {
      await apiClient.assignUserBranch(userId, branchId)
      await loadAccounts()
    } catch (error) {
      setAccountsError(error instanceof ApiError ? error.message : 'Не удалось назначить филиал')
    } finally {
      setBusyAccountId(null)
    }
  }

  const changeAccountStatus = async (account: CoachAccount) => {
    setBusyAccountId(account.id)
    try {
      if (account.status === 'Активен') await apiClient.deactivateUser(account.id)
      else await apiClient.activateUser(account.id)
      await loadAccounts()
    } catch (error) {
      setAccountsError(error instanceof ApiError ? error.message : 'Не удалось изменить доступ тренера')
    } finally {
      setBusyAccountId(null)
    }
  }

  const resetPassword = async (userId: string) => {
    const newPassword = passwords[userId] || ''
    if (newPassword.length < 8) {
      setAccountsError('Временный пароль должен содержать не менее 8 символов')
      return
    }
    setBusyAccountId(userId)
    try {
      await apiClient.resetCoachPassword(userId, newPassword)
      setPasswords((current) => ({ ...current, [userId]: '' }))
      setAccountsError(null)
    } catch (error) {
      setAccountsError(error instanceof ApiError ? error.message : 'Не удалось сбросить пароль')
    } finally {
      setBusyAccountId(null)
    }
  }

  const linkAccount = async (coachId: string) => {
    const userId = linkingAccounts[coachId]
    if (!userId) {
      setAccountsError('Выберите аккаунт для связи с карточкой тренера')
      return
    }
    setBusyAccountId(userId)
    try {
      await apiClient.linkCoachUser(coachId, userId)
      await store.initialize(true)
      await loadAccounts()
      setLinkingAccounts((current) => ({ ...current, [coachId]: '' }))
    } catch (error) {
      setAccountsError(error instanceof ApiError ? error.message : 'Не удалось связать аккаунт с тренером')
    } finally {
      setBusyAccountId(null)
    }
  }

  const deleteCoach = async (coachId: string, coachName: string) => {
    if (
      !window.confirm(
        'Удалить карточку тренера «' +
          coachName +
          '»? Связанный аккаунт будет деактивирован, история посещений и платежей сохранится.',
      )
    )
      return
    try {
      await store.deleteCoach(coachId)
      await loadAccounts()
    } catch (error) {
      setAccountsError(error instanceof ApiError ? error.message : 'Не удалось удалить тренера')
    }
  }

  const handleSubmit = async () => {
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
      await loadAccounts()
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Не удалось создать тренера')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Тренеры</h2>
        {store.authStore.isAdmin && (
          <Dialog open={isAddCoachOpen} onOpenChange={handleAddDialogChange}>
            <DialogTrigger render={<Button className="rounded-full bg-cyan-500 hover:bg-cyan-600 text-white" />}>
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
                  value={formData.branchId}
                  onValueChange={(value) => value && setFormData({ ...formData, branchId: value })}
                >
                  <SelectTrigger className="h-12 rounded-xl" aria-label="Филиал тренера">
                    <SelectValue placeholder="Выберите филиал" />
                  </SelectTrigger>
                  <SelectContent>
                    {store.branches.map((branch) => (
                      <SelectItem key={branch.id} value={String(branch.id)}>
                        {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!store.selectedBranchId && (
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
                  disabled={isCreating}
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
        <Card className="rounded-2xl border-amber-200 bg-amber-50/60">
          <CardContent className="grid gap-4 p-5">
            <div>
              <h3 className="font-semibold text-slate-900">Доступы тренеров</h3>
              <p className="mt-1 text-sm text-slate-600">
                Здесь можно назначить филиал, временно отключить вход, восстановить доступ и выдать новый пароль.
              </p>
            </div>
            {accountsError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{accountsError}</p>}
            {accounts.length === 0 ? (
              <p className="text-sm text-slate-500">Аккаунтов тренеров пока нет.</p>
            ) : (
              accounts.map((account) => (
                <div
                  key={account.id}
                  className="grid gap-3 rounded-xl border border-amber-200 bg-white p-4 lg:grid-cols-[minmax(0,1fr)_220px_auto] lg:items-center"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800">{account.username}</p>
                    <p className="text-xs text-slate-500">
                      {branchLabel(account.branchId)} · {account.status}
                      {account.disabledAt ? ' · отключён ' + account.disabledAt.slice(0, 10) : ''}
                    </p>
                  </div>
                  <Select
                    value={assigningBranches[account.id] || account.branchId || ''}
                    onValueChange={(value) =>
                      value && setAssigningBranches((current) => ({ ...current, [account.id]: value }))
                    }
                  >
                    <SelectTrigger className="rounded-xl" aria-label={'Филиал для ' + account.username}>
                      <SelectValue placeholder="Выберите филиал" />
                    </SelectTrigger>
                    <SelectContent>
                      {store.branches.map((branch) => (
                        <SelectItem key={branch.id} value={String(branch.id)}>
                          {branch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyAccountId === account.id || store.branches.length === 0}
                      onClick={() => void assignBranch(account.id)}
                    >
                      Филиал
                    </Button>
                    <Button
                      variant={account.status === 'Активен' ? 'destructive' : 'default'}
                      size="sm"
                      disabled={busyAccountId === account.id}
                      onClick={() => void changeAccountStatus(account)}
                    >
                      <UserRoundCheck className="mr-1 size-3.5" />{' '}
                      {account.status === 'Активен' ? 'Отключить' : 'Активировать'}
                    </Button>
                  </div>
                  <div className="flex gap-2 lg:col-start-2 lg:col-span-2">
                    <Input
                      type="password"
                      value={passwords[account.id] || ''}
                      onChange={(event) =>
                        setPasswords((current) => ({ ...current, [account.id]: event.target.value }))
                      }
                      placeholder="Новый временный пароль"
                      className="h-9 rounded-lg"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyAccountId === account.id}
                      onClick={() => void resetPassword(account.id)}
                    >
                      <KeyRound className="mr-1 size-3.5" /> Сбросить
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {coaches.length === 0 ? (
          <p className="col-span-full py-10 text-center text-slate-500">В этом филиале пока нет тренеров</p>
        ) : (
          coaches.map((coach) => {
            const linkedAccount = accounts.find((account) => account.id === coach.userId)
            const linkableAccounts = accounts.filter(
              (account) =>
                account.branchId === String(coach.branchId) &&
                (!linkedUserIds.has(account.id) || account.id === coach.userId),
            )
            return (
              <Card key={coach.id} className="rounded-2xl border-cyan-100 hover:shadow-md transition-shadow">
                <CardContent className="grid gap-4 p-6">
                  <div className="flex items-center gap-4">
                    <div className="flex size-16 items-center justify-center rounded-full bg-gradient-to-tr from-cyan-100 to-pink-100 text-xl font-bold text-cyan-700">
                      {coach.initials}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-lg text-slate-900">{coach.name}</h3>
                      <p className="text-sm text-slate-500">{coach.specialty}</p>
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
                  {store.authStore.isAdmin && (
                    <div className="grid gap-2 border-t border-slate-100 pt-4">
                      {linkedAccount ? (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm text-slate-600">
                            Доступ: <span className="font-medium">{linkedAccount.username}</span> ·{' '}
                            {linkedAccount.status}
                          </p>
                          <Button
                            variant={linkedAccount.status === 'Активен' ? 'destructive' : 'outline'}
                            size="sm"
                            disabled={busyAccountId === linkedAccount.id}
                            onClick={() => void changeAccountStatus(linkedAccount)}
                          >
                            {linkedAccount.status === 'Активен' ? 'Отключить доступ' : 'Активировать доступ'}
                          </Button>
                        </div>
                      ) : linkableAccounts.length > 0 ? (
                        <>
                          <p className="text-sm text-amber-700">Аккаунт ещё не связан с карточкой.</p>
                          <div className="flex gap-2">
                            <Select
                              value={linkingAccounts[coach.id] || ''}
                              onValueChange={(value) =>
                                value && setLinkingAccounts((current) => ({ ...current, [coach.id]: value }))
                              }
                            >
                              <SelectTrigger
                                className="h-9 min-w-0 flex-1 rounded-lg"
                                aria-label={'Аккаунт для ' + coach.name}
                              >
                                <SelectValue placeholder="Выберите аккаунт" />
                              </SelectTrigger>
                              <SelectContent>
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
                              disabled={busyAccountId !== null}
                              onClick={() => void linkAccount(coach.id)}
                            >
                              <Link2 className="mr-1 size-3.5" /> Связать
                            </Button>
                          </div>
                        </>
                      ) : (
                        <p className="text-sm text-slate-500">Доступ в CRM не создан.</p>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-fit text-rose-600 hover:text-rose-700"
                        onClick={() => void deleteCoach(coach.id, coach.name)}
                      >
                        <Trash2 className="mr-1 size-3.5" /> Удалить карточку
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })
        )}
      </div>
    </div>
  )
})
