'use client'

import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useStore } from '@/store/StoreProvider'
import { ILesson } from '@/store/models'
import { toLocalDateOnly } from '@/lib/utils/date'
import { CalendarDays, LayoutDashboard, LogOut, MapPin, Waves } from 'lucide-react'
import { CoachDashboard } from './CoachDashboard'
import { AttendanceModal } from './AttendanceModal'
import { ScheduleView } from './ScheduleView'
import { WorkspaceBoundary } from './WorkspaceBoundary'

export const CoachWorkspace = observer(() => {
  const store = useStore()
  const [selectedLesson, setSelectedLesson] = useState<ILesson | null>(null)
  const [occurrenceDate, setOccurrenceDate] = useState<string | null>(null)
  const [online, setOnline] = useState(true)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const now = new Date()
  const screen = store.currentScreen === 'Расписание' ? 'Расписание' : 'Дашборд'
  const username = store.authStore.user?.username || 'Тренер'
  const navigation = [
    { title: 'Дашборд', icon: LayoutDashboard },
    { title: 'Расписание', icon: CalendarDays },
  ] as const

  return (
    <div className="min-h-screen bg-[#f4f7fa] text-slate-900 xl:flex">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200/80 bg-white p-6 xl:flex">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-cyan-600 text-white shadow-lg shadow-cyan-100">
            <Waves className="size-6" />
          </span>
          <div>
            <p className="text-xl font-extrabold tracking-tight">
              Лотос<span className="text-cyan-600">.</span>
            </p>
            <p className="text-xs text-slate-400">Кабинет тренера</p>
          </div>
        </div>
        <p className="mb-3 mt-12 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Рабочее пространство
        </p>
        <nav aria-label="Разделы тренера" className="grid gap-2">
          {navigation.map(({ title, icon: Icon }) => (
            <button
              key={title}
              type="button"
              aria-current={screen === title ? 'page' : undefined}
              onClick={() => store.setScreen(title)}
              className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-cyan-600 ${screen === title ? 'bg-cyan-50 text-cyan-800' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
            >
              <Icon className="size-5" />
              {title}
              {screen === title && <span className="ml-auto size-1.5 rounded-full bg-cyan-600" />}
            </button>
          ))}
        </nav>
        <div className="mt-auto rounded-2xl bg-slate-50 p-4">
          <p className="text-xs font-medium text-slate-700">Всё для рабочего дня</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Расписание и посещаемость — без лишних разделов.
          </p>
        </div>
        <div className="mt-5 flex items-center gap-3 border-t border-slate-100 pt-5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-cyan-100 text-sm font-semibold text-cyan-800">
            {username.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{username}</p>
            <p className="text-xs text-slate-400">Тренер</p>
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="border-b border-slate-200/80 bg-white px-4 py-5 sm:px-8">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-700 xl:hidden">
                Лотос · кабинет тренера
              </p>
              <p className="flex items-center gap-2 text-sm font-semibold">
                <MapPin className="size-4 shrink-0 text-cyan-600" />
                <span className="truncate">{store.currentBranch?.name || 'Ваш филиал'}</span>
              </p>
            </div>
            <button
              type="button"
              disabled={store.authStore.isLoading}
              onClick={() => void store.authStore.logout()}
              className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-cyan-600 disabled:opacity-50"
            >
              <LogOut className="size-4" /> Выйти
            </button>
          </div>
        </header>
        <main className="mx-auto grid max-w-6xl gap-4 px-4 py-6 sm:gap-6 sm:px-8 sm:py-8">
          <nav
            aria-label="Разделы тренера на мобильном"
            className="flex gap-1 rounded-2xl border border-slate-200 bg-white p-1 xl:hidden"
          >
            {(['Дашборд', 'Расписание'] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-current={screen === item ? 'page' : undefined}
                onClick={() => store.setScreen(item)}
                className={`flex-1 rounded-xl px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-cyan-600 ${screen === item ? 'bg-cyan-700 text-white' : 'text-slate-500'}`}
              >
                {item}
              </button>
            ))}
          </nav>
          {!online && (
            <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
              Нет соединения. Отметки нельзя отправить в таблицу до восстановления связи. Автоматической отправки нет.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-600">
              {now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>
            <button
              type="button"
              disabled={store.isLoading || !online || Boolean(selectedLesson)}
              onClick={() => void store.initialize(true)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-medium text-slate-600 hover:border-cyan-200 focus-visible:outline-2 focus-visible:outline-cyan-600 disabled:opacity-50"
            >
              {store.isLoading ? 'Загружаем…' : 'Обновить расписание'}
            </button>
          </div>
          {store.error && (
            <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
              <p>{store.error}</p>
              <p className="mt-2">
                {store.hasLoadedData
                  ? 'Показано последнее загруженное расписание. При открытии занятия доступ и список учеников проверяются заново.'
                  : 'Нажмите «Обновить расписание», чтобы повторить загрузку.'}
              </p>
              {store.requiresAccessRefresh && (
                <button
                  type="button"
                  disabled={store.authStore.isLoading}
                  onClick={() => void store.authStore.init(true)}
                  className="mt-3 rounded-xl border border-amber-300 bg-white px-4 py-2"
                >
                  Повторить проверку доступа
                </button>
              )}
            </div>
          )}
          <WorkspaceBoundary key={`${store.authStore.sessionVersion}:${screen}`}>
            {!store.hasLoadedData ? (
              <p role="status" className="rounded-xl border border-slate-200 bg-white p-6">
                {store.isLoading
                  ? 'Загружаем расписание…'
                  : 'Расписание пока недоступно. Это не означает, что занятий нет.'}
              </p>
            ) : screen === 'Расписание' ? (
              <ScheduleView />
            ) : (
              <section className="grid gap-6">
                <CoachDashboard
                  lessons={store.sortedBranchLessons}
                  branchName={store.currentBranch?.name || 'Ваш филиал'}
                  now={now}
                  onSchedule={() => store.setScreen('Расписание')}
                  onOpenLesson={(lesson, date) => {
                    setOccurrenceDate(toLocalDateOnly(date))
                    setSelectedLesson({ ...lesson })
                  }}
                />
                <AttendanceModal
                  isOpen={Boolean(selectedLesson)}
                  lesson={selectedLesson}
                  occurrenceDate={occurrenceDate}
                  onClose={() => setSelectedLesson(null)}
                />
              </section>
            )}
          </WorkspaceBoundary>
          <footer className="flex flex-wrap items-center justify-between gap-2 pb-2 text-[11px] text-slate-400">
            <span>Лотос · пространство для вашей команды</span>
            <span className="flex items-center gap-1.5">
              <span className={`size-1.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              {online ? 'Подключение к сети есть' : 'Нет подключения к сети'}
            </span>
          </footer>
        </main>
      </div>
    </div>
  )
})
