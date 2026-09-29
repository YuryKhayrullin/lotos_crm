'use client'

import { observer } from 'mobx-react-lite'
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/store/StoreProvider'
import { CreateClientDto, IClient } from '@/store/models'
import { apiClient } from '@/lib/api-client'
import { packagePrice, calculatePaymentLessons } from '@/lib/subscription-pricing'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Plus,
  Search,
  ChevronDown,
  ChevronUp,
  CalendarDays,
  Mail,
  Phone,
  UserRound,
  Waves,
  CreditCard,
  History,
  ArrowUpRight,
  Loader2,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const formatPhone = (value: string) => {
  const phone = value.replace(/\D/g, '').slice(0, 11)
  if (!phone) return ''
  const digits = phone.startsWith('7') ? phone : `7${phone}`
  return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`.trim()
}

const formatBirthDate = (value: string) =>
  value
    .replace(/\D/g, '')
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/\.(\d{2})(\d)/, '.$1.$2')
    .slice(0, 10)

const calculateAge = (birthDate: string) => {
  const [day, month, year] = birthDate.split('.').map(Number)
  if (!day || !month || !year) return '0 лет'
  const today = new Date()
  let age = today.getFullYear() - year
  if (today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day)) age--
  return `${Math.max(age, 0)} лет`
}

const statusStyle = (status: string) =>
  ({
    Активен: 'bg-emerald-100 text-emerald-700',
    Пауза: 'bg-amber-100 text-amber-700',
    Архив: 'bg-slate-100 text-slate-600',
  })[status] || 'bg-slate-100 text-slate-600'

type FormState = {
  childName: string
  parentName: string
  phone: string
  email: string
  birthDate: string
  category: 'плавание' | 'синхронное плавание' | ''
  lessonsPerWeek: string
  paidAmount: string
  branchId: string
}

const emptyForm = (branchId = ''): FormState => ({
  childName: '',
  parentName: '',
  phone: '',
  email: '',
  birthDate: '',
  category: '',
  lessonsPerWeek: '',
  paidAmount: '',
  branchId,
})

export const ClientsView = observer(() => {
  const store = useStore()
  const clients = store.branchClients
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'Активен' | 'Пауза' | 'Архив'>('all')
  const [sortConfig, setSortConfig] = useState<{ key: keyof IClient; dir: 'asc' | 'desc' }>({
    key: 'childName',
    dir: 'asc',
  })
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [formData, setFormData] = useState<FormState>(
    emptyForm(store.selectedBranchId || String(store.branches[0]?.id || '')),
  )
  const [formError, setFormError] = useState('')
  const [isPaymentOpen, setIsPaymentOpen] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentComment, setPaymentComment] = useState('')
  const [paymentError, setPaymentError] = useState('')
  const [paymentLoading, setPaymentLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [paymentHistory, setPaymentHistory] = useState<Array<Record<string, unknown>>>([])
  const [lessonLedger, setLessonLedger] = useState<Array<Record<string, unknown>>>([])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void store.clientStore.setFilters(search, statusFilter)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search, statusFilter, store.clientStore])

  const selectedClient = selectedClientId
    ? store.clientStore.clients.find((client) => client.id === selectedClientId) || null
    : null

  useEffect(() => {
    if (!selectedClient || !store.authStore.isAdmin) {
      setPaymentHistory([])
      setLessonLedger([])
      return
    }
    let cancelled = false
    setHistoryLoading(true)
    void apiClient
      .getClientHistory(selectedClient.id)
      .then((history) => {
        if (cancelled) return
        setPaymentHistory(history.payments)
        setLessonLedger(history.ledger)
      })
      .catch(() => {
        if (!cancelled) {
          setPaymentHistory([])
          setLessonLedger([])
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedClient, store.authStore.isAdmin])

  const openPayment = () => {
    if (!selectedClient) return
    setPaymentAmount(String(packagePrice(selectedClient.category, selectedClient.lessonsPerWeek) || ''))
    setPaymentComment('')
    setPaymentError('')
    setIsPaymentOpen(true)
  }

  const submitPayment = async () => {
    if (!selectedClient) return
    const amount = Number(paymentAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setPaymentError('Введите сумму платежа больше нуля')
      return
    }
    setPaymentLoading(true)
    setPaymentError('')
    try {
      await apiClient.recordPayment(
        selectedClient.id,
        amount,
        selectedClient.category,
        selectedClient.lessonsPerWeek,
        paymentComment.trim(),
      )
      await store.clientStore.loadClients()
      setIsPaymentOpen(false)
      const history = await apiClient.getClientHistory(selectedClient.id)
      setPaymentHistory(history.payments)
      setLessonLedger(history.ledger)
    } catch (error) {
      setPaymentError(error instanceof Error ? error.message : 'Не удалось сохранить платёж')
    } finally {
      setPaymentLoading(false)
    }
  }
  const filteredClients = useMemo(
    () =>
      [...clients]
        .filter(
          (client) =>
            !search ||
            [client.childName, client.parentName, client.phone].some((value) =>
              value.toLowerCase().includes(search.toLowerCase()),
            ),
        )
        .filter((client) => statusFilter === 'all' || client.status === statusFilter)
        .sort((a, b) => {
          const result = String(a[sortConfig.key] ?? '').localeCompare(String(b[sortConfig.key] ?? ''), 'ru', {
            numeric: true,
          })
          return sortConfig.dir === 'asc' ? result : -result
        }),
    [clients, search, statusFilter, sortConfig],
  )

  const toggleSort = (key: keyof IClient) =>
    setSortConfig((previous) => ({ key, dir: previous.key === key && previous.dir === 'asc' ? 'desc' : 'asc' }))

  const updateForm = (field: keyof FormState, value: string) =>
    setFormData((previous) => {
      const next = { ...previous, [field]: value }
      if ((field === 'category' || field === 'lessonsPerWeek') && next.category && next.lessonsPerWeek) {
        const price = packagePrice(next.category, next.lessonsPerWeek)
        if (price > 0) next.paidAmount = String(price)
      }
      return next
    })

  const openAdd = () => {
    setFormError('')
    setFormData(emptyForm(store.selectedBranchId || String(store.branches[0]?.id || '')))
    setIsAddOpen(true)
  }

  const handleSubmit = async () => {
    if (!formData.childName.trim() || !formData.parentName.trim()) return setFormError('Укажите имя ребёнка и родителя')
    if (formData.phone.replace(/\D/g, '').length < 11) return setFormError('Введите полный номер телефона')
    if (!formData.category || !formData.lessonsPerWeek || !formData.branchId)
      return setFormError('Заполните категорию, занятия и филиал')
    if (formData.birthDate && !/^\d{2}\.\d{2}\.\d{4}$/.test(formData.birthDate))
      return setFormError('Дата должна быть в формате ДД.ММ.ГГГГ')

    const packageLessons = Number(formData.lessonsPerWeek) * 4
    const clientData: CreateClientDto = {
      childName: formData.childName.trim(),
      parentName: formData.parentName.trim(),
      phone: formData.phone,
      email: formData.email.trim(),
      birthDate: formData.birthDate,
      age: calculateAge(formData.birthDate),
      branchId: formData.branchId,
      status: 'Активен',
      category: formData.category,
      lessonsPerWeek: Number(formData.lessonsPerWeek) as 1 | 2 | 3,
      paidAmount: Number(formData.paidAmount || 0),
      initials: formData.childName
        .split(' ')
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase(),
      subscription: {
        totalLessons: packageLessons,
        remainingLessons: packageLessons,
        paid: Number(formData.paidAmount || 0) > 0,
        purchasedAt: '',
        receiptUrl: '',
      },
    }
    try {
      await store.clientStore.addClient(clientData)
      setIsAddOpen(false)
      setFormData(emptyForm(formData.branchId))
      setFormError('')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Не удалось сохранить клиента')
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Клиенты и дети</h2>
        {store.authStore.isAdmin && (
          <Button onClick={openAdd} className="w-full rounded-full bg-cyan-600 hover:bg-cyan-700 sm:w-auto">
            <Plus className="mr-2 size-4" /> Добавить клиента
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Поиск по имени, родителю или телефону..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="rounded-xl pl-10"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700"
        >
          <option value="all">Все статусы</option>
          <option value="Активен">Активные</option>
          <option value="Пауза">Пауза</option>
          <option value="Архив">Архив</option>
        </select>
      </div>

      <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead onClick={() => toggleSort('childName')} className="cursor-pointer">
                Имя{' '}
                {sortConfig.key === 'childName' &&
                  (sortConfig.dir === 'asc' ? (
                    <ChevronUp className="inline size-4" />
                  ) : (
                    <ChevronDown className="inline size-4" />
                  ))}
              </TableHead>
              <TableHead>Родитель / Телефон</TableHead>
              <TableHead>Остаток</TableHead>
              <TableHead onClick={() => toggleSort('paidAmount')} className="cursor-pointer">
                Баланс
              </TableHead>
              <TableHead>Статус</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredClients.map((client) => (
              <TableRow
                key={client.id}
                className="cursor-pointer hover:bg-slate-50"
                onClick={() => setSelectedClientId(client.id)}
              >
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <div className="flex size-8 items-center justify-center rounded-full bg-cyan-100 text-xs font-bold text-cyan-700">
                      {client.initials || client.childName.slice(0, 2).toUpperCase()}
                    </div>
                    {client.childName}
                  </div>
                </TableCell>
                <TableCell>
                  {client.parentName}
                  <br />
                  <span className="text-xs text-slate-500">{client.phone}</span>
                </TableCell>
                <TableCell>
                  {client.remainingLessons} / {client.totalLessons}
                </TableCell>
                <TableCell>{client.paidAmount} ₽</TableCell>
                <TableCell>
                  <Badge className={statusStyle(client.status)}>{client.status}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="grid gap-3 md:hidden">
        {filteredClients.map((client) => (
          <button
            key={client.id}
            onClick={() => setSelectedClientId(client.id)}
            className="rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-bold text-slate-900">{client.childName}</p>
                <p className="text-sm text-slate-500">{client.parentName}</p>
                <p className="text-sm text-slate-500">{client.phone}</p>
              </div>
              <Badge className={statusStyle(client.status)}>{client.status}</Badge>
            </div>
            <p className="mt-3 text-sm font-semibold text-cyan-700">
              {client.remainingLessons} / {client.totalLessons} занятий
            </p>
          </button>
        ))}
      </div>

      {store.clientStore.hasMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => void store.clientStore.loadNextPage(store.selectedBranchId || undefined)}
            disabled={store.clientStore.isLoading}
            className="rounded-full border-cyan-200 text-cyan-700"
          >
            {store.clientStore.isLoading ? 'Загрузка…' : 'Загрузить ещё'}
          </Button>
        </div>
      )}

      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto rounded-[28px] border-0 bg-slate-50 p-0 shadow-2xl">
          <div className="bg-gradient-to-br from-cyan-600 to-sky-700 px-6 py-7 text-white sm:px-8">
            <DialogHeader>
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-white/15">
                <UserRound className="size-6" />
              </div>
              <DialogTitle className="text-2xl font-bold text-white">Новый клиент</DialogTitle>
              <p className="mt-1 text-sm text-cyan-50">Заполните профиль ребёнка и параметры абонемента</p>
            </DialogHeader>
          </div>
          <div className="grid gap-5 p-5 sm:p-8">
            {formError && (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
                {formError}
              </div>
            )}

            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-xl bg-cyan-50 text-cyan-700">
                  <UserRound className="size-4" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900">Личные данные</h3>
                  <p className="text-xs text-slate-500">Основная информация о ребёнке и родителе</p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium text-slate-700 sm:col-span-2">
                  <span>Имя ребёнка</span>
                  <Input
                    placeholder="Например, Екатерина"
                    value={formData.childName}
                    onChange={(event) => updateForm('childName', event.target.value)}
                    className="h-11 rounded-xl"
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                  <span>Имя родителя</span>
                  <Input
                    placeholder="Имя и фамилия"
                    value={formData.parentName}
                    onChange={(event) => updateForm('parentName', event.target.value)}
                    className="h-11 rounded-xl"
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                  <span>Телефон</span>
                  <Input
                    placeholder="+7 (___) ___-__-__"
                    value={formData.phone}
                    onChange={(event) => updateForm('phone', formatPhone(event.target.value))}
                    className="h-11 rounded-xl"
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                  <span>
                    Email <em className="font-normal text-slate-400">необязательно</em>
                  </span>
                  <Input
                    type="email"
                    placeholder="parent@mail.ru"
                    value={formData.email}
                    onChange={(event) => updateForm('email', event.target.value)}
                    className="h-11 rounded-xl"
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                  <span>Дата рождения</span>
                  <Input
                    placeholder="ДД.ММ.ГГГГ"
                    value={formData.birthDate}
                    onChange={(event) => updateForm('birthDate', formatBirthDate(event.target.value))}
                    maxLength={10}
                    className="h-11 rounded-xl"
                  />
                </label>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-xl bg-sky-50 text-sky-700">
                  <Waves className="size-4" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900">Абонемент</h3>
                  <p className="text-xs text-slate-500">Секция, нагрузка и филиал</p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                  <span>Секция</span>
                  <select
                    value={formData.category}
                    onChange={(event) => updateForm('category', event.target.value)}
                    className="h-11 rounded-xl border border-slate-200 bg-white px-3 outline-none transition focus:border-cyan-500 focus:ring-4 focus:ring-cyan-100"
                  >
                    <option value="">Выберите секцию</option>
                    <option value="плавание">Плавание</option>
                    <option value="синхронное плавание">Синхронное плавание</option>
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                  <span>Занятий в неделю</span>
                  <select
                    value={formData.lessonsPerWeek}
                    onChange={(event) => updateForm('lessonsPerWeek', event.target.value)}
                    className="h-11 rounded-xl border border-slate-200 bg-white px-3 outline-none transition focus:border-cyan-500 focus:ring-4 focus:ring-cyan-100"
                  >
                    <option value="">Выберите нагрузку</option>
                    <option value="1">1 занятие</option>
                    <option value="2">2 занятия</option>
                    <option value="3">3 занятия</option>
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                  <span>
                    Сколько оплатил клиент <em className="font-normal text-slate-400">необязательно</em>
                  </span>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    inputMode="decimal"
                    placeholder="Введите сумму в рублях"
                    value={formData.paidAmount}
                    onChange={(event) => updateForm('paidAmount', event.target.value)}
                    className="h-11 rounded-xl"
                  />
                  <span className="text-xs font-normal text-slate-500">
                    Цена пакета подставляется автоматически. Оплата начисляет занятия и сохраняется в истории.
                  </span>
                </label>
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                  <span>Филиал</span>
                  <select
                    value={formData.branchId}
                    onChange={(event) => updateForm('branchId', event.target.value)}
                    className="h-11 rounded-xl border border-slate-200 bg-white px-3 outline-none transition focus:border-cyan-500 focus:ring-4 focus:ring-cyan-100"
                  >
                    <option value="">Выберите филиал</option>
                    {store.branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {formData.category && formData.lessonsPerWeek && (
                <div className="mt-4 flex items-center justify-between gap-4 rounded-xl bg-cyan-50 px-4 py-3 text-sm">
                  <div>
                    <p className="font-medium text-cyan-900">План первого пакета</p>
                    <p className="mt-0.5 text-xs text-cyan-700">
                      {packagePrice(formData.category, formData.lessonsPerWeek).toLocaleString('ru-RU')} ₽ за 4 недели
                    </p>
                  </div>
                  <strong className="shrink-0 text-cyan-950">{Number(formData.lessonsPerWeek) * 4} занятий</strong>
                </div>
              )}
            </section>

            <Button
              onClick={handleSubmit}
              disabled={store.clientStore.isLoading}
              className="h-12 rounded-xl bg-cyan-600 text-base font-bold text-white shadow-lg shadow-cyan-200 hover:bg-cyan-700"
            >
              {store.clientStore.isLoading ? 'Сохраняем…' : 'Создать профиль клиента'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedClient} onOpenChange={(open) => !open && setSelectedClientId(null)}>
        <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto rounded-[28px] border-0 bg-slate-50 p-0 shadow-2xl">
          {selectedClient && (
            <div>
              <div className="bg-gradient-to-br from-slate-900 to-cyan-950 px-6 py-7 text-white sm:px-8">
                <DialogHeader>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="mb-3 flex size-14 items-center justify-center rounded-2xl bg-cyan-400/20 text-xl font-bold text-cyan-200">
                        {selectedClient.initials || selectedClient.childName.slice(0, 2).toUpperCase()}
                      </div>
                      <DialogTitle className="text-2xl font-bold text-white">{selectedClient.childName}</DialogTitle>
                      <p className="mt-1 text-sm text-slate-300">Профиль клиента · ID {selectedClient.id}</p>
                    </div>
                    <Badge className={statusStyle(selectedClient.status)}>{selectedClient.status}</Badge>
                  </div>
                </DialogHeader>
              </div>
              <div className="grid gap-5 p-5 sm:p-8">
                <section className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Остаток занятий</p>
                    <p className="mt-2 text-2xl font-bold text-cyan-950">
                      {selectedClient.remainingLessons}
                      <span className="text-base font-medium text-slate-400"> / {selectedClient.totalLessons}</span>
                    </p>
                  </div>
                  <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Оплачено</p>
                    <p className="mt-2 text-2xl font-bold text-cyan-950">
                      {selectedClient.paidAmount > 0
                        ? `${selectedClient.paidAmount.toLocaleString('ru-RU')} ₽`
                        : 'Не указано'}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Нагрузка</p>
                    <p className="mt-2 text-2xl font-bold text-cyan-950">
                      {selectedClient.lessonsPerWeek}{' '}
                      <span className="text-base font-medium text-slate-400">раз/нед.</span>
                    </p>
                  </div>
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="mb-4 font-bold text-slate-900">Контактная информация</h3>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="flex items-center gap-3">
                      <UserRound className="size-4 text-cyan-600" />
                      <div>
                        <p className="text-xs text-slate-400">Родитель</p>
                        <p className="font-medium text-slate-800">{selectedClient.parentName || 'Не указан'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Phone className="size-4 text-cyan-600" />
                      <div>
                        <p className="text-xs text-slate-400">Телефон</p>
                        <p className="font-medium text-slate-800">{selectedClient.phone || 'Не указан'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Mail className="size-4 text-cyan-600" />
                      <div>
                        <p className="text-xs text-slate-400">Email</p>
                        <p className="font-medium text-slate-800">{selectedClient.email || 'Не указан'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <CalendarDays className="size-4 text-cyan-600" />
                      <div>
                        <p className="text-xs text-slate-400">Дата рождения</p>
                        <p className="font-medium text-slate-800">
                          {selectedClient.birthDate || 'Не указана'}
                          {selectedClient.age && selectedClient.age !== '0 лет' ? ` · ${selectedClient.age}` : ''}
                        </p>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="mb-4 font-bold text-slate-900">Параметры абонемента</h3>
                  <div className="grid gap-3 sm:grid-cols-4">
                    <div>
                      <p className="text-xs text-slate-400">Секция</p>
                      <p className="mt-1 font-semibold text-slate-800">
                        {selectedClient.category === 'синхронное плавание' ? 'Синхронное плавание' : 'Плавание'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-400">Филиал</p>
                      <p className="mt-1 font-semibold text-slate-800">
                        {store.branches.find((branch) => String(branch.id) === String(selectedClient.branchId))?.name ||
                          'Не указан'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-400">Статус оплаты</p>
                      <p className="mt-1 font-semibold text-slate-700">
                        {selectedClient.paidAmount > 0 ? 'Сумма внесена' : 'Сумма не указана'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-400">Назначенных занятий</p>
                      <p className="mt-1 font-semibold text-slate-800">{selectedClient.assignedLessonIds.length}</p>
                    </div>
                  </div>
                </section>

                <section className="rounded-2xl border border-cyan-100 bg-gradient-to-br from-cyan-50 via-white to-sky-50 p-5 shadow-sm">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-3">
                      <div className="flex size-10 items-center justify-center rounded-xl bg-cyan-600 text-white shadow-lg shadow-cyan-200">
                        <CreditCard className="size-5" />
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-900">Оплаты и продление</h3>
                        <p className="mt-1 text-xs text-slate-500">
                          Каждый платёж добавляет новый пакет без создания дубля клиента
                        </p>
                      </div>
                    </div>
                    {store.authStore.isAdmin && (
                      <Button onClick={openPayment} className="rounded-xl bg-cyan-600 text-white hover:bg-cyan-700">
                        <Plus className="mr-2 size-4" /> Продлить абонемент
                      </Button>
                    )}
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-xl bg-white/80 p-3 ring-1 ring-cyan-100">
                      <p className="text-xs text-slate-500">Оплачено всего</p>
                      <p className="mt-1 text-lg font-bold text-slate-900">
                        {selectedClient.paidAmount.toLocaleString('ru-RU')} ₽
                      </p>
                    </div>
                    <div className="rounded-xl bg-white/80 p-3 ring-1 ring-cyan-100">
                      <p className="text-xs text-slate-500">Остаток денег</p>
                      <p className="mt-1 text-lg font-bold text-slate-900">
                        {selectedClient.paymentBalance.toLocaleString('ru-RU')} ₽
                      </p>
                    </div>
                    <div className="rounded-xl bg-white/80 p-3 ring-1 ring-cyan-100">
                      <p className="text-xs text-slate-500">Начислено занятий</p>
                      <p className="mt-1 text-lg font-bold text-slate-900">{selectedClient.totalLessons}</p>
                    </div>
                  </div>
                  <div className="mt-5 flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <History className="size-4 text-cyan-600" /> История платежей
                  </div>
                  {historyLoading ? (
                    <div className="mt-3 flex items-center gap-2 text-sm text-slate-500">
                      <Loader2 className="size-4 animate-spin" /> Загружаем историю…
                    </div>
                  ) : paymentHistory.length === 0 ? (
                    <p className="mt-3 text-sm text-slate-500">Платежей пока нет</p>
                  ) : (
                    <div className="mt-3 grid gap-2">
                      {paymentHistory.slice(0, 8).map((payment) => (
                        <div
                          key={String(payment.id)}
                          className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-3 ring-1 ring-slate-100"
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                              <ArrowUpRight className="size-4" />
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-slate-800">
                                {Number(payment.amount || 0).toLocaleString('ru-RU')} ₽
                              </p>
                              <p className="text-xs text-slate-500">
                                {String(payment.category || '')} · {String(payment.lessonsPerWeek || '')} раза/нед.
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-bold text-cyan-700">
                              +{String(payment.lessonsAdded || 0)} занятий
                            </p>
                            <p className="text-xs text-slate-400">{String(payment.paidAt || '').slice(0, 10)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {lessonLedger.length > 0 && (
                    <p className="mt-3 text-xs text-slate-400">В журнале движений: {lessonLedger.length} операций</p>
                  )}
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="mb-4 font-bold text-slate-900">Расписание клиента</h3>
                  {store.branchLessons.filter((lesson) => selectedClient.isAssignedTo(lesson.id)).length === 0 ? (
                    <p className="text-sm text-slate-500">Занятия пока не назначены</p>
                  ) : (
                    <div className="grid gap-2">
                      {store.branchLessons
                        .filter((lesson) => selectedClient.isAssignedTo(lesson.id))
                        .map((lesson) => (
                          <div
                            key={lesson.id}
                            className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-3 text-sm"
                          >
                            <div className="flex size-8 items-center justify-center rounded-lg bg-cyan-100 text-cyan-700">
                              <CalendarDays className="size-4" />
                            </div>
                            <div>
                              <p className="font-semibold text-slate-800">{lesson.title}</p>
                              <p className="text-xs text-slate-500">
                                {lesson.date || lesson.dayOfWeek} · {lesson.time} ·{' '}
                                {lesson.coachName || 'Тренер не указан'}
                              </p>
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={isPaymentOpen} onOpenChange={setIsPaymentOpen}>
        <DialogContent className="max-w-lg rounded-[28px] border-0 bg-slate-50 p-0 shadow-2xl">
          <div className="bg-gradient-to-br from-cyan-600 to-sky-700 px-6 py-7 text-white">
            <DialogHeader>
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-white/15">
                <CreditCard className="size-6" />
              </div>
              <DialogTitle className="text-2xl font-bold text-white">Продление абонемента</DialogTitle>
              <p className="mt-1 text-sm text-cyan-50">
                {selectedClient?.childName} · новый платёж без создания клиента
              </p>
            </DialogHeader>
          </div>
          <div className="grid gap-4 p-6">
            {paymentError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {paymentError}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
                <p className="text-xs text-slate-500">Текущий тариф</p>
                <p className="mt-1 font-bold text-slate-900">{selectedClient?.category}</p>
              </div>
              <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
                <p className="text-xs text-slate-500">Цена пакета</p>
                <p className="mt-1 font-bold text-slate-900">
                  {selectedClient
                    ? packagePrice(selectedClient.category, selectedClient.lessonsPerWeek).toLocaleString('ru-RU')
                    : 0}{' '}
                  ₽
                </p>
              </div>
            </div>
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              Сумма нового платежа
              <Input
                type="number"
                min="1"
                step="1"
                value={paymentAmount}
                onChange={(event) => setPaymentAmount(event.target.value)}
                className="h-12 rounded-xl bg-white text-lg"
                placeholder="Например, 16000"
              />
              <span className="text-xs font-normal text-slate-500">
                Можно оплатить сразу несколько месяцев — система начислит все полные пакеты.
              </span>
            </label>
            {selectedClient && Number(paymentAmount) > 0 && (
              <div className="rounded-xl bg-cyan-50 px-4 py-3 text-sm text-cyan-900">
                {(() => {
                  const info = calculatePaymentLessons(
                    selectedClient.category,
                    selectedClient.lessonsPerWeek,
                    Number(paymentAmount) + selectedClient.paymentBalance,
                  )
                  return (
                    <>
                      <strong>{info.packages} пак.</strong> · будет начислено <strong>{info.lessons} занятий</strong>
                      {info.remainder > 0 ? ` · остаток ${info.remainder.toLocaleString('ru-RU')} ₽` : ''}
                    </>
                  )
                })()}
              </div>
            )}
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              Комментарий{' '}
              <Input
                value={paymentComment}
                onChange={(event) => setPaymentComment(event.target.value)}
                className="h-11 rounded-xl bg-white"
                placeholder="Например: оплата за октябрь и ноябрь"
              />
            </label>
            <Button
              onClick={() => void submitPayment()}
              disabled={paymentLoading}
              className="h-12 rounded-xl bg-cyan-600 text-base font-bold text-white hover:bg-cyan-700"
            >
              {paymentLoading ? 'Сохраняем…' : 'Сохранить платёж'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
})
