'use client'

import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useStore } from '@/store/StoreProvider'
import { ILesson } from '@/store/models'
import { isLessonOnDay, parseTimeToHHMM, toLocalDateOnly } from '@/lib/utils/date'
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
  const todayLessons = store.sortedBranchLessons.filter((lesson) => isLessonOnDay(lesson, now))
  const screen = store.currentScreen === 'Расписание' ? 'Расписание' : 'Дашборд'

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold">Лотос · кабинет тренера</p>
            <p className="text-sm text-slate-600">{store.currentBranch?.name || 'Ваш филиал'}</p>
          </div>
          <button
            type="button"
            disabled={store.authStore.isLoading}
            onClick={() => void store.authStore.logout()}
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm disabled:opacity-50"
          >
            Выйти
          </button>
        </div>
      </header>
      <main className="mx-auto grid max-w-3xl gap-5 px-4 py-5">
        <nav aria-label="Разделы тренера" className="flex gap-2">
          {(['Дашборд', 'Расписание'] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-current={screen === item ? 'page' : undefined}
              onClick={() => store.setScreen(item)}
              className={`rounded-xl border px-4 py-2 ${screen === item ? 'border-cyan-700 bg-cyan-700 text-white' : 'border-slate-300 bg-white'}`}
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
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm disabled:opacity-50"
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
            <section className="grid gap-3">
              <h1 className="text-xl font-semibold">Сегодня в расписании</h1>
              <p className="text-sm text-slate-600">Откройте занятие, отметьте учеников и нажмите «Сохранить».</p>
              {todayLessons.length === 0 && (
                <p className="rounded-xl border border-slate-200 bg-white p-6">На сегодня занятий нет.</p>
              )}
              {todayLessons.map((lesson) => (
                <button
                  key={lesson.id}
                  type="button"
                  onClick={() => {
                    setOccurrenceDate(toLocalDateOnly(now))
                    setSelectedLesson({ ...lesson })
                  }}
                  className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-5 text-left"
                >
                  <span className="font-semibold text-cyan-800">
                    {parseTimeToHHMM(lesson.time) || 'Время не указано'}
                  </span>
                  <span>
                    <span className="block font-semibold">{lesson.title}</span>
                    <span className="block text-sm text-slate-600">{lesson.pool}</span>
                  </span>
                </button>
              ))}
              <AttendanceModal
                isOpen={Boolean(selectedLesson)}
                lesson={selectedLesson}
                occurrenceDate={occurrenceDate}
                onClose={() => setSelectedLesson(null)}
              />
            </section>
          )}
        </WorkspaceBoundary>
      </main>
    </div>
  )
})
