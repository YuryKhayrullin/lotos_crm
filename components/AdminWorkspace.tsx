'use client'

import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { getStore } from '@/store/RootStore'
import {
  ArrowRight,
  CalendarDays,
  LogOut,
  MapPin,
  Menu,
  PauseCircle,
  UsersRound,
  UserRoundCheck,
  Waves,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { ScheduleView } from '@/components/ScheduleView'
import { nav } from '@/lib/constants/nav'
import { WorkspaceBoundary } from '@/components/WorkspaceBoundary'
import { AttendanceModal } from '@/components/AttendanceModal'
import { ILesson } from '@/store/models'
import { isLessonOnDay, lessonTemporalStatus, parseTimeToHHMM, toLocalDateOnly } from '@/lib/utils/date'
import { apiClient, type AttendanceResult, type DashboardSummary } from '@/lib/api-client'
import { selectBranchAndReload } from '@/lib/branch-selection'

const store = getStore()
const loadingSection = () => <p role="status">Загружаем раздел…</p>
const ClientsView = dynamic(() => import('@/components/ClientsView').then((module) => module.ClientsView), {
  loading: loadingSection,
})
const CoachesView = dynamic(() => import('@/components/CoachesView').then((module) => module.CoachesView), {
  loading: loadingSection,
})
const SubscriptionsView = dynamic(
  () => import('@/components/SubscriptionsView').then((module) => module.SubscriptionsView),
  { loading: loadingSection },
)
const FinanceView = dynamic(() => import('@/components/FinanceView').then((module) => module.FinanceView), {
  loading: loadingSection,
})

const dashboardLessonGroups = [
  { status: 'ongoing', label: 'Идёт сейчас' },
  { status: 'upcoming', label: 'Предстоящие' },
  { status: 'unknown', label: 'Время требует проверки' },
  { status: 'completed', label: 'Завершённые' },
] as const

const Dashboard = observer(({ setScreen }: { setScreen: (s: string) => void }) => {
  const [selectedLesson, setSelectedLesson] = useState<ILesson | null>(null)
  const [selectedOccurrenceDate, setSelectedOccurrenceDate] = useState<string | null>(null)
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [summaryError, setSummaryError] = useState('')
  const [summaryRefreshToken, setSummaryRefreshToken] = useState(0)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    // Only advance the local clock; summary/bootstrap requests do not depend on it.
    const refresh = () => setNow(new Date())
    const timer = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  const confirmedBalances = useRef(new Map<string, NonNullable<AttendanceResult['client']>>())
  const mergeConfirmedBalances = (data: DashboardSummary): DashboardSummary => ({
    ...data,
    clientsPreview: data.clientsPreview.map((client) => {
      const confirmed = confirmedBalances.current.get(client.id)
      return confirmed ? { ...client, remainingLessons: confirmed.remainingLessons, status: confirmed.status } : client
    }),
  })
  const isCoach = store.authStore.isCoach
  const dashboardBranchId = store.authStore.isAdmin ? store.selectedBranchId || undefined : undefined

  useEffect(() => {
    if (isCoach) return
    const controller = new AbortController()
    confirmedBalances.current.clear()
    setSummary(null)
    setSummaryError('')
    void apiClient
      .getDashboardSummary(controller.signal, dashboardBranchId)
      .then((data) => {
        // A summary request started before a save must not overwrite the
        // confirmed balances when its delayed response finally arrives.
        if (!controller.signal.aborted) setSummary(mergeConfirmedBalances(data))
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setSummaryError(error instanceof Error ? error.message : 'Не удалось загрузить сводку')
      })
    return () => controller.abort()
  }, [dashboardBranchId, isCoach, summaryRefreshToken])

  const todayLessons = store.sortedBranchLessons.filter((lesson) => isLessonOnDay(lesson, now))
  const todayDate = toLocalDateOnly(now)
  const displayedLessons = todayLessons
    .map((lesson) => {
      const time = parseTimeToHHMM(lesson.time)
      return { lesson, time, status: lessonTemporalStatus(todayDate, time, lesson.duration, now) }
    })
    .sort((left, right) => left.time.localeCompare(right.time))
  const metrics = [
    { label: 'Всего клиентов', value: summary?.totalClients, icon: UsersRound, detail: 'Включая архив' },
    { label: 'Активных клиентов', value: summary?.activeClients, icon: UserRoundCheck, detail: 'Статус «Активен»' },
    { label: 'На паузе', value: summary?.pausedClients, icon: PauseCircle, detail: 'Статус «Пауза»' },
    {
      label: 'Занятий сегодня',
      value: store.hasLoadedData === false ? undefined : todayLessons.length,
      icon: CalendarDays,
      detail: 'По выбранным филиалам',
    },
  ]

  return (
    <div className="grid gap-6">
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-3xl bg-gradient-to-br from-[#103c4a] via-[#0c5265] to-[#078b9e] p-6 text-white sm:p-7">
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200">Оперативная сводка</p>
          <h2 className="text-2xl font-semibold tracking-tight">{store.currentBranch?.name || 'Все филиалы'}</h2>
          <p className="mt-2 text-sm text-cyan-50/80">
            {now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setScreen('Расписание')}
          className="flex items-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-cyan-950 hover:bg-cyan-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          Открыть расписание
          <ArrowRight className="size-4" />
        </button>
      </section>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {metrics.map(({ label, value, icon: Icon, detail }) => (
          <div key={label} className="min-w-0 rounded-2xl border border-slate-200/80 bg-white p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-slate-500">{label}</p>
              <Icon className="size-4 shrink-0 text-cyan-600" />
            </div>
            <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">{value ?? '—'}</p>
            <p className="mt-1 text-xs text-slate-500">{detail}</p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {!isCoach && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-900">Клиенты</h2>
              <button
                type="button"
                onClick={() => setScreen('Клиенты и дети')}
                className="flex items-center gap-1 text-xs font-semibold text-cyan-700 focus-visible:outline-2 focus-visible:outline-cyan-600"
              >
                Все клиенты
                <ArrowRight className="size-3.5" />
              </button>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200/80 overflow-hidden">
              {!summary && !summaryError && <p className="p-5 text-sm text-slate-500">Загружаем клиентов…</p>}
              {summaryError && (
                <div role="alert" className="p-5 text-sm text-rose-700">
                  <p>Не удалось загрузить сводку клиентов</p>
                  <button
                    type="button"
                    onClick={() => setSummaryRefreshToken((value) => value + 1)}
                    className="mt-3 rounded-lg border border-rose-200 px-3 py-2 font-medium"
                  >
                    Повторить загрузку
                  </button>
                </div>
              )}
              {summary?.clientsPreview.map((client) => (
                <button
                  type="button"
                  key={client.id}
                  onClick={() => setScreen('Клиенты и дети')}
                  className="flex w-full items-center justify-between gap-3 p-5 text-left border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors focus-visible:outline-2 focus-visible:outline-cyan-600"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="size-10 shrink-0 rounded-xl bg-cyan-50 text-cyan-700 flex items-center justify-center font-semibold">
                      {client.initials || client.childName.charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-900">{client.childName}</p>
                      <p className="text-sm text-slate-500">
                        Родитель: {client.parentName} • {client.phone}
                      </p>
                    </div>
                  </div>
                  <Badge
                    variant="secondary"
                    className="shrink-0 bg-cyan-50 text-cyan-800 text-xs px-3 py-1.5 rounded-full font-semibold"
                  >
                    {client.remainingLessons} занятий
                  </Badge>
                </button>
              ))}
              {summary && summary.clientsPreview.length === 0 && (
                <p className="p-5 text-sm text-slate-500">Клиентов для показа нет</p>
              )}
              {summary && summary.previewTotal > summary.clientsPreview.length && (
                <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
                  Показаны первые {summary.clientsPreview.length} из {summary.previewTotal} неархивных клиентов
                </p>
              )}
            </div>
          </div>
        )}

        <div className="space-y-4">
          <div className="flex justify-between items-center gap-3">
            <h2 className="text-lg font-semibold text-slate-900">Сегодня в расписании</h2>
            <button
              type="button"
              onClick={() => setScreen('Расписание')}
              className="flex items-center gap-1 text-xs font-semibold text-cyan-700 focus-visible:outline-2 focus-visible:outline-cyan-600"
            >
              Все занятия
              <ArrowRight className="size-3.5" />
            </button>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200/80 overflow-hidden">
            {(() => {
              if (todayLessons.length === 0)
                return (
                  <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
                    <span className="flex size-12 items-center justify-center rounded-2xl bg-cyan-50 text-cyan-700">
                      <CalendarDays className="size-6" />
                    </span>
                    <p className="font-medium text-slate-700">На сегодня занятий нет</p>
                    <button
                      type="button"
                      onClick={() => setScreen('Расписание')}
                      className="text-xs font-semibold text-cyan-700"
                    >
                      Выбрать другой день
                    </button>
                  </div>
                )

              return dashboardLessonGroups.map(({ status, label }) => {
                const entries = displayedLessons.filter((entry) => entry.status === status)
                if (!entries.length) return null
                return (
                  <div key={status} data-lesson-status={status}>
                    <h3 className="border-y border-slate-100 bg-slate-50 px-5 py-3 text-xs font-semibold text-slate-600">
                      {label}
                    </h3>
                    {entries.map(({ lesson, time }) => (
                      <button
                        type="button"
                        key={lesson.id}
                        onClick={() => {
                          setSelectedOccurrenceDate(todayDate)
                          setSelectedLesson(lesson)
                        }}
                        className="flex w-full items-center justify-between gap-3 p-5 text-left border-b border-slate-100 last:border-0 hover:bg-cyan-50/40 transition-colors focus-visible:outline-2 focus-visible:outline-cyan-600"
                      >
                        <div className="flex items-center gap-4">
                          <div
                            className={`font-semibold px-3 py-3 rounded-xl text-lg ${status === 'completed' ? 'bg-slate-100 text-slate-500' : 'bg-cyan-50 text-cyan-800'}`}
                          >
                            {time}
                          </div>
                          <div>
                            <p className="font-semibold text-slate-900">{lesson.title}</p>
                            <p className="text-sm text-slate-500">{lesson.coachName}</p>
                          </div>
                        </div>
                        <ArrowRight className="size-4 shrink-0 text-cyan-700" />
                      </button>
                    ))}
                  </div>
                )
              })
            })()}
          </div>
        </div>
      </div>
      <AttendanceModal
        isOpen={!!selectedLesson}
        onClose={() => setSelectedLesson(null)}
        lesson={selectedLesson}
        occurrenceDate={selectedOccurrenceDate}
        onSaved={(results) => {
          // Normal saves update the visible balances without another GAS call.
          // An older backend may omit snapshots: refresh once, never invent a
          // local deduction (especially for corrections and idempotent retries).
          if (results.some((result) => !result.client)) {
            setSummaryRefreshToken((value) => value + 1)
            return
          }
          results.forEach((result) => {
            if (result.client) confirmedBalances.current.set(result.clientId, result.client)
          })
          setSummary((current) => (current ? mergeConfirmedBalances(current) : current))
        }}
      />
    </div>
  )
})

export const AdminWorkspace = observer(() => {
  const reloadForBranch = (branchId: string) => selectBranchAndReload(store, branchId)
  const username = store.authStore.user?.username || 'Администратор'

  if (store.isLoading)
    return (
      <div role="status" className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#f4f7fa]">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-cyan-700 text-white">
          <Waves className="size-7" />
        </span>
        <p className="text-sm font-medium text-slate-500">Загрузка рабочего пространства…</p>
      </div>
    )

  return (
    <div className="flex min-h-screen bg-[#f4f7fa] text-slate-900">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white p-4 xl:flex">
        <div className="flex items-center gap-3 px-2 py-2 mb-8">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-cyan-700 text-white shadow-lg shadow-cyan-700/15">
            <Waves className="size-6" />
          </div>
          <div>
            <p className="text-xl font-extrabold tracking-tight text-slate-900">
              Лотос<span className="text-cyan-600">.</span>
            </p>
            <p className="text-xs text-slate-500">Администрирование</p>
          </div>
        </div>
        <p className="mb-3 px-4 text-[11px] font-semibold uppercase tracking-widest text-slate-400">Разделы</p>
        <nav aria-label="Разделы администратора" className="flex flex-grow flex-col gap-1">
          {nav.map((item) => {
            if (store.authStore.isCoach && item.label !== 'Дашборд' && item.label !== 'Расписание') return null
            return (
              <button
                key={item.label}
                type="button"
                aria-current={store.currentScreen === item.label ? 'page' : undefined}
                onClick={() => store.setScreen(item.label)}
                className={`flex w-full items-center gap-3 px-4 py-3 rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-cyan-600 ${
                  store.currentScreen === item.label
                    ? 'bg-cyan-50 text-cyan-800 font-semibold'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <item.icon className="size-5 shrink-0" />
                <span className="text-sm font-medium">{item.label}</span>
                {store.currentScreen === item.label && <span className="ml-auto size-1.5 rounded-full bg-cyan-600" />}
              </button>
            )
          })}
        </nav>
        <div className="mt-6 rounded-2xl border border-slate-100 bg-slate-50 p-4">
          <p className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <MapPin className="size-3.5" /> Текущий филиал
          </p>
          <p className="mt-2 text-sm font-semibold text-slate-800">{store.currentBranch?.name || 'Все филиалы'}</p>
          {store.currentBranch?.address && <p className="mt-1 text-xs text-slate-500">{store.currentBranch.address}</p>}
        </div>
        <div className="mt-5 flex items-center gap-3 border-t border-slate-100 pt-5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-cyan-100 text-sm font-semibold text-cyan-800">
            {username.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{username}</p>
            <p className="text-xs text-slate-400">Администратор</p>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 py-4 backdrop-blur-md sm:px-8">
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="xl:hidden"
              aria-label="Открыть меню"
              onClick={store.toggleSidebar}
            >
              <Menu className="size-5" />
            </Button>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">{store.currentScreen}</h1>
          </div>

          <div className="hidden flex-col items-center 2xl:flex">
            <div className="text-sm text-slate-500 mt-0.5">
              {new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {store.authStore.isAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="inline-flex rounded-xl border-slate-200 px-3"
                onClick={store.toggleBranchMenu}
              >
                <span className="hidden sm:inline">Филиалы</span>
                <span className="sm:hidden">Фил.</span>
              </Button>
            )}
            {store.authStore.isAdmin && (
              <Select
                items={[
                  { value: 'all', label: 'Все филиалы' },
                  ...store.branches.map((branch) => ({ value: String(branch.id), label: branch.name })),
                ]}
                value={store.selectedBranchId || 'all'}
                onValueChange={(value) => reloadForBranch(!value || value === 'all' ? '' : value)}
              >
                <SelectTrigger
                  aria-label="Выберите филиал"
                  className="h-9 w-[160px] sm:w-[190px] rounded-xl border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-none"
                >
                  <SelectValue placeholder="Все филиалы">{store.currentBranch?.name || 'Все филиалы'}</SelectValue>
                </SelectTrigger>
                <SelectContent
                  alignItemWithTrigger={false}
                  className="rounded-2xl border-slate-200 bg-white p-1 shadow-xl"
                >
                  <SelectItem value="all" className="rounded-xl py-2.5">
                    Все филиалы
                  </SelectItem>
                  {store.branches.map((branch) => (
                    <SelectItem key={branch.id} value={String(branch.id)} className="rounded-xl py-2.5">
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {store.authStore.isAuthenticated && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => store.authStore.logout()}
                className="rounded-xl h-9 border-slate-200 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 transition-colors"
              >
                <LogOut className="size-4 mr-2" /> Выйти
              </Button>
            )}
          </div>
        </header>

        <Sheet open={store.sidebarOpen} onOpenChange={store.closeSidebar}>
          <SheetContent side="left" className="w-[280px] border-r border-slate-200 bg-white p-4">
            <SheetTitle className="mb-6 text-lg font-bold text-cyan-950">Лотос CRM</SheetTitle>
            <nav className="flex flex-col gap-2">
              {nav.map((item) => {
                if (store.authStore.isCoach && item.label !== 'Дашборд' && item.label !== 'Расписание') return null
                return (
                  <button
                    key={item.label}
                    onClick={() => store.setScreen(item.label)}
                    className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-all ${
                      store.currentScreen === item.label
                        ? 'bg-cyan-100/80 text-cyan-700 font-semibold shadow-sm'
                        : 'text-slate-700 hover:bg-white/80'
                    }`}
                  >
                    <item.icon className="size-5 shrink-0" />
                    <span className="font-medium">{item.label}</span>
                  </button>
                )
              })}
            </nav>
          </SheetContent>
        </Sheet>

        <Sheet open={store.branchMenuOpen} onOpenChange={store.closeBranchMenu}>
          <SheetContent side="right" className="w-[350px] max-w-full border-l border-slate-200 bg-white p-0 shadow-2xl">
            <div className="border-b border-slate-100 p-6">
              <SheetTitle className="text-xl font-bold text-cyan-900">Управление филиалами</SheetTitle>
            </div>

            <div className="p-6 flex flex-col gap-6">
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Мои филиалы</h3>
                <div className="grid gap-2">
                  <button
                    onClick={() => reloadForBranch('')}
                    className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
                      !store.selectedBranchId
                        ? 'border-cyan-400 bg-cyan-50 text-cyan-900 font-semibold shadow-sm'
                        : 'border-slate-100 hover:border-cyan-200 hover:bg-slate-50 text-slate-700'
                    }`}
                  >
                    Все филиалы
                  </button>
                  {store.branches.map((branch) => (
                    <button
                      key={branch.id}
                      onClick={() => reloadForBranch(String(branch.id))}
                      className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
                        String(store.selectedBranchId) === String(branch.id)
                          ? 'border-cyan-400 bg-cyan-50 text-cyan-900 font-semibold shadow-sm'
                          : 'border-slate-100 hover:border-cyan-200 hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      {branch.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="pt-6 border-t border-slate-100">
                <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4">Добавить новый</h3>
                <div className="flex flex-col gap-3">
                  <Input
                    id="new-branch-name"
                    placeholder="Название филиала"
                    className="border-slate-200 focus:border-cyan-400 rounded-lg"
                  />
                  <Input
                    id="new-branch-address"
                    placeholder="Адрес филиала"
                    className="border-slate-200 focus:border-cyan-400 rounded-lg"
                  />
                  {store.error && <p className="text-xs text-rose-500 font-medium">{store.error}</p>}
                  <Button
                    onClick={() => {
                      const name = (document.getElementById('new-branch-name') as HTMLInputElement).value
                      const address = (document.getElementById('new-branch-address') as HTMLInputElement).value
                      if (name && address) store.addBranch(name, address)
                    }}
                    className="w-full rounded-xl bg-cyan-700 text-white font-semibold hover:bg-cyan-800"
                  >
                    Создать филиал
                  </Button>
                </div>
              </div>
            </div>
          </SheetContent>
        </Sheet>

        <main className="mx-auto w-full max-w-[1440px] p-4 sm:p-8">
          {store.error && (
            <div
              role="alert"
              className="mb-4 flex items-center justify-between gap-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
            >
              <span>{store.error}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 rounded-full border-rose-300 text-rose-700 hover:bg-rose-100"
                onClick={() => {
                  store.setError(null)
                  void store.initialize()
                }}
              >
                Повторить
              </Button>
            </div>
          )}
          <WorkspaceBoundary key={store.currentScreen}>
            {store.currentScreen === 'Дашборд' && <Dashboard setScreen={store.setScreen} />}
            {store.currentScreen === 'Клиенты и дети' && <ClientsView />}
            {store.currentScreen === 'Расписание' && <ScheduleView />}
            {store.currentScreen === 'Тренеры' && <CoachesView />}
            {store.currentScreen === 'Абонементы' && <SubscriptionsView />}
            {store.currentScreen === 'Финансы' && <FinanceView />}
            {store.currentScreen !== 'Дашборд' &&
              store.currentScreen !== 'Клиенты и дети' &&
              store.currentScreen !== 'Расписание' &&
              store.currentScreen !== 'Тренеры' &&
              store.currentScreen !== 'Абонементы' &&
              store.currentScreen !== 'Финансы' && <div>Раздел «{store.currentScreen}» в разработке</div>}
          </WorkspaceBoundary>
        </main>
      </div>
    </div>
  )
})
