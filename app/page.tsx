'use client'

import { observer } from 'mobx-react-lite'
import { useEffect } from 'react'
import dynamic from 'next/dynamic'
import { getStore } from '@/store/RootStore'
import { LoginPage } from '@/components/LoginPage'
import { CoachWorkspace } from '@/components/CoachWorkspace'
import { RecoveryPanel } from '@/components/RecoveryPanel'

const store = getStore()
const AdminWorkspace = dynamic(() => import('@/components/AdminWorkspace').then((module) => module.AdminWorkspace), {
  loading: () => (
    <p role="status" className="p-6">
      Загружаем кабинет администратора…
    </p>
  ),
})

const Page = observer(() => {
  const isInitialized = store.authStore.isInitialized
  const isAuthenticated = store.authStore.isAuthenticated
  const sessionVersion = store.authStore.sessionVersion
  const sessionError = store.authStore.sessionError

  useEffect(() => {
    if (!isInitialized || !isAuthenticated || sessionError) {
      store.cancelInitialize()
      return
    }
    if (isInitialized && isAuthenticated) {
      if (store.authStore.isCoach && store.currentScreen !== 'Дашборд' && store.currentScreen !== 'Расписание') {
        store.setScreen('Дашборд')
      }
      store.initialize()
    }
  }, [isInitialized, isAuthenticated, sessionVersion, sessionError])

  if (sessionError) {
    return (
      <main className="min-h-screen bg-slate-50 p-6 pt-16">
        <RecoveryPanel
          title="Не удалось проверить доступ"
          message={sessionError}
          onRetry={() => void store.authStore.init(true)}
        />
        {store.authStore.user && (
          <button
            type="button"
            className="mx-auto mt-4 block rounded-xl border p-3"
            disabled={store.authStore.isLoading}
            onClick={() => void store.authStore.logout()}
          >
            Повторить выход
          </button>
        )}
      </main>
    )
  }

  if (!isInitialized) {
    return <div className="flex min-h-screen items-center justify-center text-slate-500">Проверка сессии…</div>
  }

  if (!isAuthenticated) {
    return <LoginPage />
  }

  if (store.authStore.isCoach) return <CoachWorkspace />

  return <AdminWorkspace />
})

export default Page
