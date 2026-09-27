'use client'

import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { getStore } from '@/store/RootStore'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Plus } from 'lucide-react'
import { apiClient, ApiError } from '@/lib/api-client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const store = getStore()

const formatPhone = (value: string) => {
  const phone = value.replace(/\D/g, '').slice(0, 11)
  if (!phone) return ''
  if (phone.length === 1) return `+7 (${phone.replace('7', '')}`
  if (phone.length < 5) return `+7 (${phone.slice(1)}`
  if (phone.length < 8) return `+7 (${phone.slice(1, 4)}) ${phone.slice(4)}`
  if (phone.length < 10) return `+7 (${phone.slice(1, 4)}) ${phone.slice(4, 7)}-${phone.slice(7)}`
  return `+7 (${phone.slice(1, 4)}) ${phone.slice(4, 7)}-${phone.slice(7, 9)}-${phone.slice(9)}`
}

const formatBirthDate = (value: string) => {
  return value
    .replace(/\D/g, '')
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/\.(\d{2})(\d)/, '.$1.$2')
    .slice(0, 10)
}

export const CoachesView = observer(() => {
  const coaches = store.branchCoaches
  const sessionVersion = store.authStore.sessionVersion
  const [isAddCoachOpen, setIsAddCoachOpen] = useState(false)
  const [formData, setFormData] = useState({ name: '', surname: '', phone: '', birthDate: '', username: '', password: '' })
  const [formError, setFormError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<Array<{ id: string; username: string; role: 'admin' | 'coach'; branchId: string | null }>>([])
  const [assigningBranches, setAssigningBranches] = useState<Record<string, string>>({})
  const [accountsError, setAccountsError] = useState<string | null>(null)

  const loadAccounts = async () => {
    try {
      const users = await apiClient.fetchUsers()
      setAccounts(users)
      setAccountsError(null)
    } catch (error) {
      setAccountsError(error instanceof ApiError ? error.message : 'Не удалось загрузить аккаунты')
    }
  }

  useEffect(() => {
    if (store.authStore.isAdmin) void loadAccounts()
  }, [sessionVersion])

  const assignBranch = async (userId: string) => {
    const branchId = assigningBranches[userId] || (store.branches.length === 1 ? String(store.branches[0].id) : '')
    if (!branchId) {
      setAccountsError('Выберите филиал для тренера')
      return
    }
    try {
      await apiClient.assignUserBranch(userId, branchId)
      await loadAccounts()
    } catch (error) {
      setAccountsError(error instanceof ApiError ? error.message : 'Не удалось назначить филиал')
    }
  }

  const handleSubmit = async () => {
    setFormError(null)
    const fullName = `${formData.name} ${formData.surname}`.trim()
    if (!fullName) {
      setFormError('Укажите имя и фамилию тренера')
      return
    }
    if ((formData.username && !formData.password) || (!formData.username && formData.password)) {
      setFormError('Для создания доступа укажите и логин, и пароль')
      return
    }
    store.setCoachFormName(fullName)
    store.setCoachFormSpecialty('Тренер')
    try {
      if (formData.username && formData.password) {
        await apiClient.createUser({
          username: formData.username.trim(),
          password: formData.password,
          role: 'coach',
          ...(store.selectedBranchId ? { branchId: String(store.selectedBranchId) } : {}),
        })
      }
      await store.createCoach()
      setIsAddCoachOpen(false)
      setFormData({ name: '', surname: '', phone: '', birthDate: '', username: '', password: '' })
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Не удалось создать тренера')
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Тренеры</h2>
        {store.authStore.isAdmin && (
          <Dialog open={isAddCoachOpen} onOpenChange={setIsAddCoachOpen}>
            <DialogTrigger className="rounded-full bg-cyan-100 hover:bg-cyan-200 text-cyan-800 shadow-sm transition-all px-4 py-2 text-sm inline-flex items-center justify-center font-medium">
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
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
                />
                <Input
                  placeholder="Фамилия"
                  value={formData.surname}
                  onChange={(e) => setFormData({ ...formData, surname: e.target.value })}
                  className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
                />
                <Input
                  placeholder="+7 (000) 000-00-00"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: formatPhone(e.target.value) })}
                  className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
                />
                <Input
                  placeholder="ДД.ММ.ГГГГ"
                  value={formData.birthDate}
                  onChange={(e) => setFormData({ ...formData, birthDate: formatBirthDate(e.target.value) })}
                  maxLength={10}
                  className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
                />
                <div className="border-t border-slate-100 pt-5">
                  <p className="mb-3 text-sm font-semibold text-slate-800">Доступ в CRM (необязательно)</p>
                  <div className="grid gap-3">
                    <Input
                      placeholder="Логин тренера"
                      value={formData.username}
                      onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                      className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
                    />
                    <Input
                      type="password"
                      placeholder="Временный пароль"
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
                    />
                    <p className="text-xs text-slate-500">
                      Доступ будет сразу привязан к выбранному филиалу. Пароль передайте тренеру безопасным способом.
                    </p>
                  </div>
                </div>
                <Button
                  onClick={handleSubmit}
                  className="w-full rounded-full bg-cyan-500 hover:bg-cyan-600 text-white font-bold h-12 shadow-lg transition-all"
                >
                  Сохранить
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
              <h3 className="font-semibold text-slate-900">Ожидают назначения филиала</h3>
              <p className="mt-1 text-sm text-slate-600">Зарегистрированные тренеры не смогут войти в CRM, пока вы не назначите филиал.</p>
            </div>
            {accountsError && <p className="text-sm text-rose-600">{accountsError}</p>}
            {accounts.filter((account) => !account.branchId).length === 0 ? (
              <p className="text-sm text-slate-500">Новых аккаунтов без филиала нет.</p>
            ) : (
              accounts.filter((account) => !account.branchId).map((account) => (
                <div key={account.id} className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-white p-4 sm:flex-row sm:items-center">
                  <span className="min-w-0 flex-1 font-medium text-slate-800">{account.username}</span>
                  {store.branches.length > 1 && (
                    <Select
                      value={assigningBranches[account.id] || ''}
                      onValueChange={(value) => value && setAssigningBranches((current) => ({ ...current, [account.id]: value }))}
                    >
                      <SelectTrigger className="w-full rounded-xl sm:w-56" aria-label={`Филиал для ${account.username}`}>
                        <SelectValue placeholder="Выберите филиал" />
                      </SelectTrigger>
                      <SelectContent>
                        {store.branches.map((branch) => <SelectItem key={branch.id} value={String(branch.id)}>{branch.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                  <Button onClick={() => void assignBranch(account.id)} disabled={store.branches.length === 0}>
                    {store.branches.length === 1 ? `Назначить ${store.branches[0].name}` : 'Назначить филиал'}
                  </Button>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {coaches.length === 0 ? (
          <p className="col-span-full text-center py-10 text-slate-500">В этом филиале пока нет тренеров</p>
        ) : (
          coaches.map((coach) => (
            <Card key={coach.id} className="rounded-2xl border-cyan-100 hover:shadow-md transition-shadow">
              <CardContent className="p-6 flex items-center gap-4">
                <div className="size-16 rounded-full bg-gradient-to-tr from-cyan-100 to-pink-100 flex items-center justify-center text-xl font-bold text-cyan-700">
                  {coach.initials}
                </div>
                <div>
                  <h3 className="font-bold text-lg text-slate-900">{coach.name}</h3>
                  <p className="text-sm text-slate-500">{coach.specialty}</p>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
})
