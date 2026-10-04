'use client'

import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { getStore } from '@/store/RootStore'
import { LogOut, Menu } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { ClientsView } from '@/components/ClientsView'
import { ScheduleView } from '@/components/ScheduleView'
import { CoachesView } from '@/components/CoachesView'
import { SubscriptionsView } from '@/components/SubscriptionsView'
import { LoginPage } from '@/components/LoginPage'
import { nav } from '@/lib/constants/nav'
import { FinanceView } from '@/components/FinanceView'
import { AttendanceModal } from '@/components/AttendanceModal'
import { ILesson } from '@/store/models'
import { isLessonOnDay, toLocalDateOnly } from '@/lib/utils/date'
import { apiClient, type DashboardSummary } from '@/lib/api-client'
import { selectBranchAndReload } from '@/lib/branch-selection'

const store = getStore()

const Dashboard = observer(({ setScreen }: { setScreen: (s: string) => void }) => {
  const [selectedLesson, setSelectedLesson] = useState<ILesson | null>(null)
  const [selectedOccurrenceDate, setSelectedOccurrenceDate] = useState<string | null>(null)
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [summaryError, setSummaryError] = useState('')
  const isCoach = store.authStore.isCoach
  const dashboardBranchId = store.authStore.isAdmin ? store.selectedBranchId || undefined : undefined

  useEffect(() => {
    if (isCoach) return
    const controller = new AbortController()
    setSummary(null)
    setSummaryError('')
    void apiClient
      .getDashboardSummary(controller.signal, dashboardBranchId)
      .then((data) => {
        if (!controller.signal.aborted) setSummary(data)
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setSummaryError(error instanceof Error ? error.message : 'Не удалось загрузить сводку')
      })
    return () => controller.abort()
  }, [dashboardBranchId, isCoach])

  const formatTime = (timeValue: string | number) => {
    const normalizedTime = String(timeValue ?? '')
    if (!normalizedTime) return '--:--'
    if (/^\d{2}:\d{2}$/.test(normalizedTime)) return normalizedTime
    try {
      const date = new Date(normalizedTime)
      if (isNaN(date.getTime())) return normalizedTime
      return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    } catch {
      return normalizedTime
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      {!isCoach && (
        <div className="space-y-4">
          <div className="flex justify-between items-center cursor-pointer" onClick={() => setScreen('Клиенты и дети')}>
            <h2 className="text-xl font-bold text-slate-800 hover:text-cyan-700 transition-colors">Клиенты</h2>
          </div>
          <div className="bg-white rounded-2xl border border-pink-100 shadow-sm overflow-hidden">
            {!summary && !summaryError && <p className="p-5 text-sm text-slate-500">Загружаем клиентов…</p>}
            {summaryError && <p className="p-5 text-sm text-rose-600">Не удалось загрузить список клиентов</p>}
            {summary?.clientsPreview.map((client) => (
              <div
                key={client.id}
                onClick={() => setScreen('Клиенты и дети')}
                className="flex items-center justify-between p-5 border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-4">
                  <div className="size-12 rounded-full bg-cyan-100 text-cyan-700 flex items-center justify-center font-bold text-lg">
                    {client.initials || client.childName.charAt(0)}
                  </div>
                  <div>
                    <p className="font-bold text-slate-900 text-lg">{client.childName}</p>
                    <p className="text-sm text-slate-500">
                      Родитель: {client.parentName} • {client.phone}
                    </p>
                  </div>
                </div>
                <Badge
                  variant="secondary"
                  className="bg-cyan-100 text-cyan-800 text-sm px-4 py-1.5 rounded-full font-bold"
                >
                  {client.remainingLessons} занятий
                </Badge>
              </div>
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
        <div className="flex justify-between items-center cursor-pointer" onClick={() => setScreen('Расписание')}>
          <h2 className="text-xl font-bold text-slate-800 hover:text-cyan-700 transition-colors">
            Сегодня в расписании
          </h2>
        </div>
        <div className="bg-white rounded-2xl border border-pink-100 shadow-sm overflow-hidden">
          {(() => {
            const now = new Date()
            const todayLessons = store.sortedBranchLessons.filter((lesson) => isLessonOnDay(lesson, now))

            if (todayLessons.length === 0) return <p className="p-5 text-sm text-slate-500">На сегодня занятий нет</p>

            return todayLessons.map((lesson) => (
              <div
                key={lesson.id}
                onClick={() => {
                  setSelectedOccurrenceDate(toLocalDateOnly(now))
                  setSelectedLesson(lesson)
                }}
                className="flex items-center justify-between p-5 border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors cursor-pointer bg-cyan-50/50"
              >
                <div className="flex items-center gap-4">
                  <div className="font-bold px-4 py-2 rounded-xl border text-lg bg-cyan-500 text-white border-cyan-600">
                    {formatTime(lesson.time)}
                  </div>
                  <div>
                    <p className="font-bold text-slate-900 text-lg">{lesson.title}</p>
                    <p className="text-sm text-slate-500">{lesson.coachName}</p>
                  </div>
                </div>
                <div className="text-sm font-semibold text-slate-500 bg-slate-100 px-3 py-1 rounded-full">Сегодня</div>
              </div>
            ))
          })()}
        </div>
      </div>
      <AttendanceModal
        isOpen={!!selectedLesson}
        onClose={() => setSelectedLesson(null)}
        lesson={selectedLesson}
        occurrenceDate={selectedOccurrenceDate}
      />
    </div>
  )
})

const Page = observer(() => {
  const isInitialized = store.authStore.isInitialized
  const isAuthenticated = store.authStore.isAuthenticated
  const reloadForBranch = (branchId: string) => selectBranchAndReload(store, branchId)

  useEffect(() => {
    if (!isInitialized || !isAuthenticated) {
      store.cancelInitialize()
      return
    }
    if (isInitialized && isAuthenticated) {
      if (store.authStore.isCoach && store.currentScreen !== 'Дашборд' && store.currentScreen !== 'Расписание') {
        store.setScreen('Дашборд')
      }
      store.initialize()
    }
  }, [isInitialized, isAuthenticated])

  if (!isInitialized) {
    return <div className="flex min-h-screen items-center justify-center text-slate-500">Проверка сессии…</div>
  }

  if (!isAuthenticated) {
    return <LoginPage />
  }

  if (store.isLoading) return <div className="flex min-h-screen items-center justify-center">Загрузка...</div>

  return (
    <div className="flex min-h-screen bg-[#f6fcff]">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-cyan-100 bg-[#effaff] p-4 lg:flex">
        <div className="flex items-center gap-3 px-2 py-2 mb-8">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-cyan-600 text-lg font-bold text-white shadow-lg shadow-cyan-200">
            Л
          </div>
          <div>
            <p className="font-semibold text-slate-900">Лотос</p>
            <p className="text-xs text-slate-500">CRM для бассейна</p>
          </div>
        </div>
        <nav className="flex flex-grow flex-col gap-2">
          {nav.map((item) => {
            if (store.authStore.isCoach && item.label !== 'Дашборд' && item.label !== 'Расписание') return null
            return (
              <button
                key={item.label}
                onClick={() => store.setScreen(item.label)}
                className={`flex w-full items-center gap-3 px-4 py-3 rounded-xl transition-all ${
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
        <div className="mt-6 rounded-2xl border border-cyan-100 bg-cyan-100/70 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-cyan-800/70">Текущий филиал</p>
          <p className="mt-1 font-semibold text-cyan-700">{store.currentBranch?.name || 'Все филиалы'}</p>
          {store.currentBranch?.address && <p className="mt-1 text-xs text-slate-500">{store.currentBranch.address}</p>}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-20 flex h-20 items-center justify-between border-b border-cyan-100 bg-[#f6fcff]/90 px-6 shadow-sm backdrop-blur-md">
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Открыть меню"
              onClick={store.toggleSidebar}
            >
              <Menu className="size-5" />
            </Button>
            <div className="text-2xl font-extrabold text-slate-900 tracking-tight">{store.currentScreen}</div>
          </div>

          <div className="flex flex-col items-center">
            <div className="text-sm text-cyan-700 font-semibold mt-0.5">
              {store.currentBranch?.name || 'Все филиалы'} ·{' '}
              {new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-4">
            {store.authStore.isAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="inline-flex rounded-full px-3"
                onClick={store.toggleBranchMenu}
              >
                <span className="hidden sm:inline">Филиалы</span>
                <span className="sm:hidden">Фил.</span>
              </Button>
            )}
            {store.authStore.isAdmin && (
              <Select
                value={store.selectedBranchId || 'all'}
                onValueChange={(value) => reloadForBranch(!value || value === 'all' ? '' : value)}
              >
                <SelectTrigger
                  aria-label="Выберите филиал"
                  className="h-9 w-[170px] rounded-full border-cyan-200 bg-cyan-50/60 px-4 text-sm font-semibold text-cyan-900 shadow-none transition-all hover:bg-cyan-50 focus-visible:border-cyan-400 focus-visible:ring-cyan-200"
                >
                  <SelectValue placeholder="Все филиалы">{store.currentBranch?.name || 'Все филиалы'}</SelectValue>
                </SelectTrigger>
                <SelectContent className="rounded-2xl border-cyan-100 bg-white p-1 shadow-xl">
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
                className="rounded-full h-9 border-cyan-100 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 transition-colors"
              >
                <LogOut className="size-4 mr-2" /> Выйти
              </Button>
            )}
          </div>
        </header>

        <Sheet open={store.sidebarOpen} onOpenChange={store.closeSidebar}>
          <SheetContent side="left" className="w-[280px] border-r border-cyan-100 bg-[#effaff] p-4">
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
          <SheetContent side="right" className="w-[350px] border-l border-cyan-100 bg-[#f6fcff] p-0 shadow-2xl">
            <div className="border-b border-cyan-100 bg-gradient-to-b from-cyan-50 to-white p-6">
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
                    className="w-full rounded-full bg-gradient-to-r from-cyan-500 to-pink-400 text-white font-semibold hover:from-cyan-600 hover:to-pink-500 transition-all shadow-md"
                  >
                    Создать филиал
                  </Button>
                </div>
              </div>
            </div>
          </SheetContent>
        </Sheet>

        <main className="p-4 sm:p-6">
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
            store.currentScreen !== 'Абонементы' && <div>Раздел «{store.currentScreen}» в разработке</div>}
        </main>
      </div>
    </div>
  )
})
export default Page
