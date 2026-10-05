'use client'

import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/store/StoreProvider'
import { CreateClientDto } from '@/store/models'
import { calculateAge, formatBirthDate, formatPhone } from '@/lib/formatters'
import { normalizeClient } from '@/lib/normalizers'
import { apiClient, createRequestId, type LessonLedgerDiscrepancy } from '@/lib/api-client'
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
  ClipboardCheck,
  Loader2,
  Settings2,
  Archive,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

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

type EditFormState = Pick<
  FormState,
  'childName' | 'parentName' | 'phone' | 'email' | 'birthDate' | 'category' | 'lessonsPerWeek'
>

const emptyEditForm: EditFormState = {
  childName: '',
  parentName: '',
  phone: '',
  email: '',
  birthDate: '',
  category: '',
  lessonsPerWeek: '',
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

type ClientListItem = Omit<
  ReturnType<typeof normalizeClient>,
  | 'id'
  | 'childName'
  | 'parentName'
  | 'phone'
  | 'email'
  | 'birthDate'
  | 'age'
  | 'branchId'
  | 'status'
  | 'category'
  | 'lessonsPerWeek'
  | 'initials'
  | 'paidAmount'
  | 'paymentBalance'
  | 'assignedLessonId'
  | 'assignedLessonIds'
  | 'attendanceHistory'
> & {
  id: string
  childName: string
  parentName: string
  phone: string
  email: string
  birthDate: string
  age: string
  branchId: string
  status: 'Активен' | 'Пауза' | 'Архив'
  category: 'плавание' | 'синхронное плавание'
  lessonsPerWeek: number
  initials: string
  paidAmount: number
  paymentBalance: number
  assignedLessonId: string | null
  assignedLessonIds: readonly string[]
  attendanceHistory: readonly unknown[]
  remainingLessons: number
  totalLessons: number
  isAssignedTo: (lessonId: string) => boolean
}

const toClientListItem = (client: ReturnType<typeof normalizeClient>): ClientListItem => {
  const assignedLessonIds = client.assignedLessonIds ?? []
  return {
    ...client,
    id: String(client.id || ''),
    childName: String(client.childName || ''),
    parentName: String(client.parentName || ''),
    phone: String(client.phone || ''),
    email: String(client.email || ''),
    birthDate: String(client.birthDate || ''),
    age: String(client.age || '0 лет'),
    branchId: String(client.branchId || ''),
    status: client.status === 'Пауза' || client.status === 'Архив' ? client.status : 'Активен',
    category: client.category === 'синхронное плавание' ? 'синхронное плавание' : 'плавание',
    lessonsPerWeek: Number(client.lessonsPerWeek || 1),
    initials: String(client.initials || ''),
    paidAmount: Number(client.paidAmount || 0),
    paymentBalance: Number(client.paymentBalance || 0),
    assignedLessonId: client.assignedLessonId ?? null,
    assignedLessonIds,
    attendanceHistory: client.attendanceHistory ?? [],
    remainingLessons: Number(client.subscription?.remainingLessons ?? 0),
    totalLessons: Number(client.subscription?.totalLessons ?? 0),
    isAssignedTo: (lessonId: string) => assignedLessonIds.includes(lessonId) || client.assignedLessonId === lessonId,
  }
}

const CLIENT_PAGE_SIZE = 100

export const ClientsView = observer(() => {
  const store = useStore()
  const [clients, setClients] = useState<ClientListItem[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [isListLoading, setIsListLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [reloadVersion, setReloadVersion] = useState(0)
  const clientRequestVersion = useRef(0)
  const [search, setSearch] = useState('')
  const searchQuery = search.trim()
  const [statusFilter, setStatusFilter] = useState<'all' | 'Активен' | 'Пауза' | 'Архив'>('all')
  const [sortConfig, setSortConfig] = useState<{ key: 'childName' | 'paidAmount'; dir: 'asc' | 'desc' }>({
    key: 'childName',
    dir: 'asc',
  })
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [formData, setFormData] = useState<FormState>(
    emptyForm(store.selectedBranchId || String(store.branches[0]?.id || '')),
  )
  const [formError, setFormError] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [isPaymentOpen, setIsPaymentOpen] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentComment, setPaymentComment] = useState('')
  const [paymentError, setPaymentError] = useState('')
  const [paymentLoading, setPaymentLoading] = useState(false)
  const [paymentAttempt, setPaymentAttempt] = useState<{
    clientId: string
    amount: number
    category: string
    lessonsPerWeek: number
    comment: string
    requestId: string
  } | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [paymentHistory, setPaymentHistory] = useState<Array<Record<string, unknown>>>([])
  const [lessonLedger, setLessonLedger] = useState<Array<Record<string, unknown>>>([])
  const [ledgerAudit, setLedgerAudit] = useState<LessonLedgerDiscrepancy | null>(null)
  const [ledgerAuditChecked, setLedgerAuditChecked] = useState(false)
  const [auditRepairReason, setAuditRepairReason] = useState('')
  const [auditRepairConfirmed, setAuditRepairConfirmed] = useState(false)
  const [auditRepairError, setAuditRepairError] = useState('')
  const [auditRepairLoading, setAuditRepairLoading] = useState(false)
  const [auditRepairAttempt, setAuditRepairAttempt] = useState<{
    clientId: string
    expectedRemainingLessons: number
    expectedTotalLessons: number
    reason: string
    requestId: string
  } | null>(null)
  const [isAdjustmentOpen, setIsAdjustmentOpen] = useState(false)
  const [adjustmentDelta, setAdjustmentDelta] = useState('')
  const [adjustmentReason, setAdjustmentReason] = useState('')
  const [adjustmentError, setAdjustmentError] = useState('')
  const [adjustmentLoading, setAdjustmentLoading] = useState(false)
  const [adjustmentAttempt, setAdjustmentAttempt] = useState<{
    clientId: string
    lessonsDelta: number
    reason: string
    requestId: string
  } | null>(null)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [editForm, setEditForm] = useState<EditFormState>(emptyEditForm)
  const [editError, setEditError] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [clientActionError, setClientActionError] = useState('')
  const [clientActionLoading, setClientActionLoading] = useState(false)

  const branchId = store.authStore.isAdmin ? store.selectedBranchId || undefined : undefined
  const refreshClients = () => setReloadVersion((version) => version + 1)
  const openClientProfile = (clientId: string) => {
    setClientActionError('')
    setPaymentHistory([])
    setLessonLedger([])
    setHistoryLoading(true)
    setSelectedClientId(clientId)
  }

  useEffect(() => {
    const controller = new AbortController()
    const requestVersion = ++clientRequestVersion.current
    const timer = window.setTimeout(
      () => {
        setIsListLoading(true)
        setListError('')
        void apiClient
          .fetchClientsPage(
            1,
            CLIENT_PAGE_SIZE,
            controller.signal,
            branchId,
            searchQuery || undefined,
            statusFilter === 'all' ? undefined : statusFilter,
            sortConfig.key,
            sortConfig.dir,
          )
          .then((nextPage) => {
            if (controller.signal.aborted || requestVersion !== clientRequestVersion.current) return
            setClients(nextPage.items.map(toClientListItem))
            setPage(nextPage.page)
            setTotal(nextPage.total)
            setHasMore(nextPage.hasMore)
          })
          .catch((error) => {
            if (controller.signal.aborted || requestVersion !== clientRequestVersion.current) return
            setListError(error instanceof Error ? error.message : 'Не удалось загрузить клиентов')
            setClients([])
            setTotal(0)
            setHasMore(false)
          })
          .finally(() => {
            if (!controller.signal.aborted && requestVersion === clientRequestVersion.current) setIsListLoading(false)
          })
      },
      searchQuery ? 250 : 0,
    )
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [branchId, reloadVersion, searchQuery, sortConfig, statusFilter])

  const loadNextPage = async () => {
    if (isListLoading || !hasMore) return
    const requestVersion = ++clientRequestVersion.current
    setIsListLoading(true)
    setListError('')
    try {
      const nextPage = await apiClient.fetchClientsPage(
        page + 1,
        CLIENT_PAGE_SIZE,
        undefined,
        branchId,
        search.trim() || undefined,
        statusFilter === 'all' ? undefined : statusFilter,
        sortConfig.key,
        sortConfig.dir,
      )
      if (requestVersion !== clientRequestVersion.current) return
      setClients((current) => [...current, ...nextPage.items.map(toClientListItem)])
      setPage(nextPage.page)
      setTotal(nextPage.total)
      setHasMore(nextPage.hasMore)
    } catch (error) {
      if (requestVersion === clientRequestVersion.current)
        setListError(error instanceof Error ? error.message : 'Не удалось загрузить клиентов')
    } finally {
      if (requestVersion === clientRequestVersion.current) setIsListLoading(false)
    }
  }

  const selectedClient = selectedClientId ? clients.find((client) => client.id === selectedClientId) || null : null
  const selectedAccountingClientId = selectedClient?.id ?? null
  const canDeleteSelected = Boolean(
    selectedClient &&
    !historyLoading &&
    ledgerAuditChecked &&
    paymentHistory.length === 0 &&
    lessonLedger.length === 0 &&
    selectedClient.attendanceHistory.length === 0 &&
    selectedClient.assignedLessonIds.length === 0 &&
    selectedClient.paidAmount === 0 &&
    selectedClient.totalLessons === 0,
  )

  useEffect(() => {
    if (!selectedAccountingClientId || !store.authStore.isAdmin) {
      setPaymentHistory([])
      setLessonLedger([])
      setLedgerAudit(null)
      setLedgerAuditChecked(false)
      return
    }
    let cancelled = false
    setHistoryLoading(true)
    setLedgerAuditChecked(false)
    void Promise.all([
      apiClient.getClientHistory(selectedAccountingClientId),
      apiClient.auditLessonLedger(selectedAccountingClientId),
    ])
      .then(([history, audit]) => {
        if (cancelled) return
        setPaymentHistory(history.payments)
        setLessonLedger(history.ledger)
        setLedgerAudit(audit.discrepancies[0] || null)
        setLedgerAuditChecked(true)
      })
      .catch(() => {
        if (!cancelled) {
          setPaymentHistory([])
          setLessonLedger([])
          setLedgerAudit(null)
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Refreshing the list creates new objects, not a new selected pupil.
    // Successful accounting writes explicitly refresh history/audit below.
  }, [selectedAccountingClientId, store.authStore.isAdmin])

  const openPayment = () => {
    if (!selectedClient) return
    if (!paymentAttempt || paymentAttempt.clientId !== selectedClient.id) {
      setPaymentAttempt(null)
      setPaymentAmount(String(packagePrice(selectedClient.category, selectedClient.lessonsPerWeek) || ''))
      setPaymentComment('')
    }
    setPaymentError('')
    setIsPaymentOpen(true)
  }

  const submitPayment = async () => {
    if (!selectedClient || paymentLoading) return
    const amount = Number(paymentAmount)
    if (!paymentAttempt && (!Number.isFinite(amount) || amount <= 0)) {
      setPaymentError('Введите сумму платежа больше нуля')
      return
    }
    const attempt =
      paymentAttempt?.clientId === selectedClient.id
        ? paymentAttempt
        : {
            clientId: selectedClient.id,
            amount,
            category: selectedClient.category,
            lessonsPerWeek: selectedClient.lessonsPerWeek,
            comment: paymentComment.trim(),
            requestId: createRequestId(),
          }
    setPaymentAttempt(attempt)
    setPaymentLoading(true)
    setPaymentError('')
    try {
      await apiClient.recordPayment(
        attempt.clientId,
        attempt.amount,
        attempt.category,
        attempt.lessonsPerWeek,
        attempt.comment,
        attempt.requestId,
      )
      setPaymentAttempt(null)
      setIsPaymentOpen(false)
      refreshClients()
      const [history, audit] = await Promise.all([
        apiClient.getClientHistory(attempt.clientId),
        apiClient.auditLessonLedger(attempt.clientId),
      ])
      setPaymentHistory(history.payments)
      setLessonLedger(history.ledger)
      setLedgerAudit(audit.discrepancies[0] || null)
      setLedgerAuditChecked(true)
    } catch (error) {
      // A lost HTTP response is not proof that Sheets rejected the payment.
      const history = await apiClient.getClientHistory(attempt.clientId).catch(() => null)
      if (history?.payments.some((payment) => String(payment.requestId) === attempt.requestId)) {
        setPaymentAttempt(null)
        setIsPaymentOpen(false)
        const audit = await apiClient.auditLessonLedger(attempt.clientId).catch(() => null)
        setPaymentHistory(history.payments)
        setLessonLedger(history.ledger)
        setLedgerAudit(audit?.discrepancies[0] || null)
        setLedgerAuditChecked(Boolean(audit))
        refreshClients()
      } else {
        setPaymentError(error instanceof Error ? error.message : 'Не удалось сохранить платёж')
      }
    } finally {
      setPaymentLoading(false)
    }
  }
  const openAdjustment = () => {
    if (!selectedClient) return
    setAdjustmentDelta('')
    setAdjustmentReason('')
    setAdjustmentError('')
    setAdjustmentAttempt(null)
    setIsAdjustmentOpen(true)
  }

  const openEdit = () => {
    if (!selectedClient) return
    setEditForm({
      childName: selectedClient.childName,
      parentName: selectedClient.parentName,
      phone: selectedClient.phone,
      email: selectedClient.email,
      birthDate: selectedClient.birthDate,
      category: selectedClient.category,
      lessonsPerWeek: String(selectedClient.lessonsPerWeek),
    })
    setEditError('')
    setIsEditOpen(true)
  }

  const updateEditForm = (field: keyof EditFormState, value: string) =>
    setEditForm((current) => ({ ...current, [field]: value }))

  const submitEdit = async () => {
    if (!selectedClient || isEditing) return
    if (!editForm.childName.trim() || !editForm.parentName.trim()) {
      setEditError('Укажите имя ребёнка и родителя')
      return
    }
    if (editForm.phone.replace(/\D/g, '').length < 11) {
      setEditError('Введите полный номер телефона')
      return
    }
    if (!editForm.category || !editForm.lessonsPerWeek) {
      setEditError('Выберите секцию и количество занятий в неделю')
      return
    }
    if (editForm.birthDate && !/^\d{2}\.\d{2}\.\d{4}$/.test(editForm.birthDate)) {
      setEditError('Дата должна быть в формате ДД.ММ.ГГГГ')
      return
    }
    setIsEditing(true)
    setEditError('')
    try {
      await apiClient.updateClient(selectedClient.id, {
        childName: editForm.childName.trim(),
        parentName: editForm.parentName.trim(),
        phone: editForm.phone,
        email: editForm.email.trim(),
        birthDate: editForm.birthDate,
        age: calculateAge(editForm.birthDate),
        category: editForm.category,
        lessonsPerWeek: Number(editForm.lessonsPerWeek),
        initials: editForm.childName
          .trim()
          .split(/\s+/)
          .map((part) => part[0])
          .join('')
          .slice(0, 2)
          .toUpperCase(),
      })
      setIsEditOpen(false)
      setClientActionError('')
      refreshClients()
    } catch (error) {
      setEditError(error instanceof Error ? error.message : 'Не удалось сохранить изменения')
    } finally {
      setIsEditing(false)
    }
  }

  const changeClientArchiveStatus = async (archive: boolean) => {
    if (!selectedClient || clientActionLoading) return
    const message = archive
      ? `Переместить «${selectedClient.childName}» в архив? Клиент исчезнет из roster, но история и финансы сохранятся.`
      : `Вернуть «${selectedClient.childName}» в активные клиенты?`
    if (!window.confirm(message)) return
    setClientActionLoading(true)
    setClientActionError('')
    try {
      await apiClient.updateClient(selectedClient.id, { status: archive ? 'Архив' : 'Активен' })
      setSelectedClientId(null)
      refreshClients()
    } catch (error) {
      setClientActionError(error instanceof Error ? error.message : 'Не удалось изменить статус клиента')
    } finally {
      setClientActionLoading(false)
    }
  }

  const deleteEmptyClient = async () => {
    if (!selectedClient || clientActionLoading || !canDeleteSelected) return
    if (
      !window.confirm(
        `Безвозвратно удалить пустую карточку «${selectedClient.childName}»? Это разрешено только если нет оплат, посещений и связи с расписанием.`,
      )
    )
      return
    setClientActionLoading(true)
    setClientActionError('')
    try {
      await apiClient.deleteClient(selectedClient.id)
      setSelectedClientId(null)
      refreshClients()
    } catch (error) {
      setClientActionError(error instanceof Error ? error.message : 'Не удалось удалить карточку')
    } finally {
      setClientActionLoading(false)
    }
  }

  const refreshSelectedAccounting = async (clientId: string) => {
    const [history, audit] = await Promise.all([
      apiClient.getClientHistory(clientId),
      apiClient.auditLessonLedger(clientId),
    ])
    setPaymentHistory(history.payments)
    setLessonLedger(history.ledger)
    setLedgerAudit(audit.discrepancies[0] || null)
    setLedgerAuditChecked(true)
  }

  const submitAdjustment = async () => {
    if (!selectedClient || adjustmentLoading) return
    const lessonsDelta = Number(adjustmentDelta)
    if (!adjustmentAttempt && (!Number.isInteger(lessonsDelta) || lessonsDelta === 0 || Math.abs(lessonsDelta) > 100)) {
      setAdjustmentError('Укажите целую корректировку от -100 до 100 занятий')
      return
    }
    if (!adjustmentAttempt && !adjustmentReason.trim()) {
      setAdjustmentError('Укажите обязательную причину корректировки')
      return
    }
    const attempt =
      adjustmentAttempt?.clientId === selectedClient.id
        ? adjustmentAttempt
        : { clientId: selectedClient.id, lessonsDelta, reason: adjustmentReason.trim(), requestId: createRequestId() }
    setAdjustmentAttempt(attempt)
    setAdjustmentLoading(true)
    setAdjustmentError('')
    try {
      await apiClient.recordAdjustment(attempt.clientId, attempt.lessonsDelta, attempt.reason, '', attempt.requestId)
      refreshClients()
      await refreshSelectedAccounting(attempt.clientId)
      setAdjustmentAttempt(null)
      setIsAdjustmentOpen(false)
    } catch (error) {
      setAdjustmentError(error instanceof Error ? error.message : 'Не удалось сохранить корректировку')
    } finally {
      setAdjustmentLoading(false)
    }
  }

  const submitAuditRepair = async () => {
    if (!selectedClient || !ledgerAudit || auditRepairLoading) return
    if (!auditRepairConfirmed) return setAuditRepairError('Подтвердите исправление результатов аудита')
    if (!auditRepairAttempt && !auditRepairReason.trim()) return setAuditRepairError('Укажите причину исправления')
    const attempt =
      auditRepairAttempt?.clientId === selectedClient.id
        ? auditRepairAttempt
        : {
            clientId: selectedClient.id,
            expectedRemainingLessons: ledgerAudit.current.remainingLessons,
            expectedTotalLessons: ledgerAudit.current.totalLessons,
            reason: auditRepairReason.trim(),
            requestId: createRequestId(),
          }
    setAuditRepairAttempt(attempt)
    setAuditRepairLoading(true)
    setAuditRepairError('')
    try {
      await apiClient.repairLessonLedger(
        attempt.clientId,
        attempt.expectedRemainingLessons,
        attempt.expectedTotalLessons,
        attempt.reason,
        attempt.requestId,
      )
      refreshClients()
      await refreshSelectedAccounting(attempt.clientId)
      setAuditRepairAttempt(null)
      setAuditRepairConfirmed(false)
      setAuditRepairReason('')
    } catch (error) {
      setAuditRepairError(error instanceof Error ? error.message : 'Не удалось исправить журнал')
    } finally {
      setAuditRepairLoading(false)
    }
  }

  const filteredClients = clients

  const toggleSort = (key: 'childName' | 'paidAmount') =>
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
    setIsCreating(true)
    try {
      await apiClient.createClient(clientData)
      refreshClients()
      setIsAddOpen(false)
      setFormData(emptyForm(formData.branchId))
      setFormError('')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Не удалось сохранить клиента')
    } finally {
      setIsCreating(false)
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

      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>Найдено клиентов: {total}</span>
        {isListLoading && <span>Загрузка…</span>}
      </div>
      {listError && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          Не удалось загрузить клиентов
        </p>
      )}

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
                onClick={() => openClientProfile(client.id)}
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
            onClick={() => openClientProfile(client.id)}
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

      {hasMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => void loadNextPage()}
            disabled={isListLoading}
            className="rounded-full border-cyan-200 text-cyan-700"
          >
            {isListLoading ? 'Загрузка…' : 'Загрузить ещё'}
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
              disabled={isCreating}
              className="h-12 rounded-xl bg-cyan-600 text-base font-bold text-white shadow-lg shadow-cyan-200 hover:bg-cyan-700"
            >
              {isCreating ? 'Сохраняем…' : 'Создать профиль клиента'}
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
                {store.authStore.isAdmin && (
                  <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={openEdit} disabled={clientActionLoading}>
                        <Pencil className="mr-2 size-4" /> Редактировать
                      </Button>
                      {selectedClient.status === 'Архив' ? (
                        <Button
                          variant="outline"
                          onClick={() => void changeClientArchiveStatus(false)}
                          disabled={clientActionLoading}
                          className="border-emerald-200 text-emerald-700"
                        >
                          <RotateCcw className="mr-2 size-4" /> Восстановить
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          onClick={() => void changeClientArchiveStatus(true)}
                          disabled={clientActionLoading}
                          className="border-amber-200 text-amber-700"
                        >
                          <Archive className="mr-2 size-4" /> В архив
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        onClick={() => void deleteEmptyClient()}
                        disabled={clientActionLoading || !canDeleteSelected}
                        title={
                          historyLoading || !ledgerAuditChecked
                            ? 'Проверяем историю клиента'
                            : canDeleteSelected
                              ? 'Удалить пустую ошибочно созданную карточку'
                              : 'Карточку с оплатами, посещениями или расписанием можно только архивировать'
                        }
                        className="border-rose-200 text-rose-700"
                      >
                        <Trash2 className="mr-2 size-4" /> Удалить пустую карточку
                      </Button>
                    </div>
                    {!canDeleteSelected && (
                      <p className="mt-3 text-xs text-slate-500">
                        {historyLoading || !ledgerAuditChecked
                          ? 'Проверяем платежи, посещения и журнал перед удалением…'
                          : 'Удаление недоступно: используемая карточка должна остаться в истории. Её можно архивировать.'}
                      </p>
                    )}
                    {clientActionError && (
                      <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{clientActionError}</p>
                    )}
                  </section>
                )}
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
                    {store.authStore.isAdmin && selectedClient.status !== 'Архив' && (
                      <div className="flex flex-wrap gap-2">
                        <Button onClick={openPayment} className="rounded-xl bg-cyan-600 text-white hover:bg-cyan-700">
                          <Plus className="mr-2 size-4" /> Продлить абонемент
                        </Button>
                        <Button
                          variant="outline"
                          onClick={openAdjustment}
                          className="rounded-xl border-cyan-200 text-cyan-800"
                        >
                          <Settings2 className="mr-2 size-4" /> Корректировка
                        </Button>
                      </div>
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
                  {store.authStore.isAdmin && ledgerAuditChecked && (
                    <div className="mt-5 rounded-xl border border-slate-200 bg-white/80 p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                        <ClipboardCheck className="size-4 text-cyan-600" /> Сверка журнала занятий
                      </div>
                      {!ledgerAudit ? (
                        <p className="mt-2 text-sm text-emerald-700">
                          Остаток и начисленные занятия совпадают с журналом и платежами.
                        </p>
                      ) : (
                        <div className="mt-3 grid gap-3 text-sm">
                          <p className="text-amber-800">
                            В карточке: {ledgerAudit.current.remainingLessons} / {ledgerAudit.current.totalLessons}; по
                            журналу: {ledgerAudit.calculated.remainingLessons} / {ledgerAudit.calculated.totalLessons}.
                          </p>
                          {[...ledgerAudit.ledgerIssues, ...ledgerAudit.paymentIssues].map((issue) => (
                            <p key={issue} className="text-rose-700">
                              {issue}
                            </p>
                          ))}
                          {ledgerAudit.missingPaymentIds.length > 0 && (
                            <p className="text-amber-800">
                              Не связаны с журналом платежи: {ledgerAudit.missingPaymentIds.join(', ')}.
                            </p>
                          )}
                          {ledgerAudit.repairable ? (
                            <div className="grid gap-2 rounded-lg bg-amber-50 p-3">
                              <p className="text-xs text-amber-900">
                                Исправление создаст отдельную подтверждённую запись в журнале и не изменит историю
                                платежей.
                              </p>
                              <Input
                                value={auditRepairReason}
                                onChange={(event) => setAuditRepairReason(event.target.value)}
                                disabled={auditRepairLoading || Boolean(auditRepairAttempt)}
                                placeholder="Причина исправления"
                                className="h-10 bg-white"
                              />
                              <label className="flex items-start gap-2 text-xs text-slate-700">
                                <input
                                  type="checkbox"
                                  checked={auditRepairConfirmed}
                                  disabled={auditRepairLoading || Boolean(auditRepairAttempt)}
                                  onChange={(event) => setAuditRepairConfirmed(event.target.checked)}
                                />
                                Подтверждаю, что проверил(а) расхождение и хочу восстановить журнал.
                              </label>
                              {auditRepairError && <p className="text-xs text-rose-700">{auditRepairError}</p>}
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void submitAuditRepair()}
                                disabled={auditRepairLoading || !auditRepairConfirmed || !auditRepairReason.trim()}
                                className="w-fit border-amber-300 bg-white text-amber-900"
                              >
                                {auditRepairLoading ? 'Исправляем…' : 'Подтвердить исправление'}
                              </Button>
                            </div>
                          ) : (
                            <p className="text-xs text-rose-700">
                              Автоматическое исправление заблокировано: сначала устраните противоречия в журнале или
                              платежах.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
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

      <Dialog open={isEditOpen && !!selectedClient} onOpenChange={setIsEditOpen}>
        <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto rounded-[28px] border-0 bg-slate-50 p-0 shadow-2xl">
          <div className="bg-gradient-to-br from-cyan-700 to-sky-800 px-6 py-7 text-white">
            <DialogHeader>
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-white/15">
                <Pencil className="size-6" />
              </div>
              <DialogTitle className="text-2xl font-bold text-white">Редактирование клиента</DialogTitle>
              <p className="mt-1 text-sm text-cyan-50">
                Баланс занятий и суммы меняются только через платёж или журналируемую корректировку.
              </p>
            </DialogHeader>
          </div>
          <div className="grid gap-4 p-6">
            {editError && (
              <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {editError}
              </p>
            )}
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              Имя ребёнка
              <Input
                value={editForm.childName}
                onChange={(event) => updateEditForm('childName', event.target.value)}
                disabled={isEditing}
                className="h-11 bg-white"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              Родитель
              <Input
                value={editForm.parentName}
                onChange={(event) => updateEditForm('parentName', event.target.value)}
                disabled={isEditing}
                className="h-11 bg-white"
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Телефон
                <Input
                  inputMode="tel"
                  value={editForm.phone}
                  onChange={(event) => updateEditForm('phone', formatPhone(event.target.value))}
                  disabled={isEditing}
                  className="h-11 bg-white"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Email
                <Input
                  type="email"
                  value={editForm.email}
                  onChange={(event) => updateEditForm('email', event.target.value)}
                  disabled={isEditing}
                  className="h-11 bg-white"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Дата рождения
                <Input
                  inputMode="numeric"
                  value={editForm.birthDate}
                  maxLength={10}
                  onChange={(event) => updateEditForm('birthDate', formatBirthDate(event.target.value))}
                  disabled={isEditing}
                  placeholder="ДД.ММ.ГГГГ"
                  className="h-11 bg-white"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Секция
                <select
                  value={editForm.category}
                  onChange={(event) => updateEditForm('category', event.target.value)}
                  disabled={isEditing}
                  className="h-11 rounded-md border border-slate-200 bg-white px-3"
                >
                  <option value="плавание">Плавание</option>
                  <option value="синхронное плавание">Синхронное плавание</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-slate-700 sm:col-span-2">
                Нагрузка для следующей покупки
                <select
                  value={editForm.lessonsPerWeek}
                  onChange={(event) => updateEditForm('lessonsPerWeek', event.target.value)}
                  disabled={isEditing}
                  className="h-11 rounded-md border border-slate-200 bg-white px-3"
                >
                  <option value="1">1 занятие в неделю</option>
                  <option value="2">2 занятия в неделю</option>
                  <option value="3">3 занятия в неделю</option>
                </select>
              </label>
            </div>
            <Button
              onClick={() => void submitEdit()}
              disabled={isEditing}
              className="h-12 rounded-xl bg-cyan-700 text-base font-bold text-white hover:bg-cyan-800"
            >
              {isEditing ? 'Сохраняем…' : 'Сохранить изменения'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isAdjustmentOpen} onOpenChange={setIsAdjustmentOpen}>
        <DialogContent className="max-w-lg rounded-[28px] border-0 bg-slate-50 p-0 shadow-2xl">
          <div className="bg-gradient-to-br from-amber-500 to-orange-600 px-6 py-7 text-white">
            <DialogHeader>
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-white/15">
                <Settings2 className="size-6" />
              </div>
              <DialogTitle className="text-2xl font-bold text-white">Корректировка абонемента</DialogTitle>
              <p className="mt-1 text-sm text-amber-50">
                Операция будет записана в журнал с автором, причиной и остатком до/после.
              </p>
            </DialogHeader>
          </div>
          <div className="grid gap-4 p-6">
            {adjustmentError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {adjustmentError}
              </div>
            )}
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              Изменение занятий
              <Input
                type="number"
                min="-100"
                max="100"
                step="1"
                value={adjustmentDelta}
                disabled={adjustmentLoading || Boolean(adjustmentAttempt)}
                onChange={(event) => setAdjustmentDelta(event.target.value)}
                placeholder="Например, 2 или -1"
                className="h-12 bg-white text-lg"
              />
              <span className="text-xs font-normal text-slate-500">
                Положительное число начисляет, отрицательное уменьшает и общий лимит, и остаток.
              </span>
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              Причина <span className="text-rose-600">*</span>
              <Input
                value={adjustmentReason}
                disabled={adjustmentLoading || Boolean(adjustmentAttempt)}
                onChange={(event) => setAdjustmentReason(event.target.value)}
                placeholder="Например: корректировка после смены тарифа"
                className="h-11 bg-white"
              />
            </label>
            <Button
              onClick={() => void submitAdjustment()}
              disabled={adjustmentLoading}
              className="h-12 rounded-xl bg-amber-600 text-base font-bold text-white hover:bg-amber-700"
            >
              {adjustmentLoading ? 'Сохраняем…' : 'Сохранить корректировку'}
            </Button>
          </div>
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
                disabled={paymentLoading || Boolean(paymentAttempt)}
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
                disabled={paymentLoading || Boolean(paymentAttempt)}
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
