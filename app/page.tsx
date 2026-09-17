'use client'

import { observer } from 'mobx-react-lite'
import { useEffect } from 'react'
import { getStore } from '@/store/RootStore'
import { Menu, LogOut } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { ClientsView } from '@/components/ClientsView'
import { ScheduleView } from '@/components/ScheduleView'
import { CoachesView } from '@/components/CoachesView'
import { LoginPage } from '@/components/LoginPage'
import { nav } from '@/lib/constants/nav'
import { RoleGuard } from '@/components/RoleGuard'

const store = getStore()

const Dashboard = observer(({ setScreen }: { setScreen: (s: string) => void }) => {
  const formatTime = (timeValue: string) => {
    if (!timeValue) return '--:--';
    if (/^\d{2}:\d{2}$/.test(timeValue)) return timeValue;
    try {
      const date = new Date(timeValue);
      if (isNaN(date.getTime())) return timeValue;
      return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return timeValue;
    }
  }

  // Проверка: является ли урок "текущим" (сравнение даты)
  const isCurrentDate = (isoString: string) => {
    try {
      const lessonDate = new Date(isoString);
      const now = new Date();
      return lessonDate.getDate() === now.getDate() &&
             lessonDate.getMonth() === now.getMonth() &&
             lessonDate.getFullYear() === now.getFullYear();
    } catch { return false; }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      <div className="space-y-4">
        <div className="flex justify-between items-center cursor-pointer" onClick={() => setScreen('Клиенты и дети')}>
          <h2 className="text-xl font-bold text-slate-800 hover:text-cyan-700 transition-colors">Клиенты</h2>
        </div>
        <div className="bg-white rounded-2xl border border-pink-100 shadow-sm overflow-hidden">
          {store.branchClients.map(client => (
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
                  <p className="text-sm text-slate-500">Родитель: {client.parentName} • {client.phone}</p>
                </div>
              </div>
              <Badge variant="secondary" className="bg-cyan-100 text-cyan-800 text-sm px-4 py-1.5 rounded-full font-bold">
                {client.remainingLessons} занятий
              </Badge>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex justify-between items-center cursor-pointer" onClick={() => setScreen('Расписание')}>
          <h2 className="text-xl font-bold text-slate-800 hover:text-cyan-700 transition-colors">Сегодня в расписании</h2>
        </div>
        <div className="bg-white rounded-2xl border border-pink-100 shadow-sm overflow-hidden">
          {(() => {
            const now = new Date();
            const todayLessons = store.sortedBranchLessons.filter(lesson => {
              const d = lesson.date ? new Date(lesson.date) : new Date(lesson.time);
              return d.getDate() === now.getDate() && 
                     d.getMonth() === now.getMonth() && 
                     d.getFullYear() === now.getFullYear();
            });
            
            if (todayLessons.length === 0) return <p className="p-5 text-sm text-slate-500">На сегодня занятий нет</p>;

            return todayLessons.map(lesson => (
              <div 
                key={lesson.id} 
                onClick={() => setScreen('Расписание')}
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
                <div className="text-sm font-semibold text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
                    Сегодня
                </div>
              </div>
            ))
          })()}
        </div>
      </div>
    </div>
  )
})

const Page = observer(() => {
  useEffect(() => {
    if (store.authStore.isAuthenticated) {
      store.initialize()
    }
  }, [store.authStore.isAuthenticated])

  if (!store.authStore.isAuthenticated) {
    return <LoginPage />
  }

  if (store.isLoading) return <div className="flex min-h-screen items-center justify-center">Загрузка...</div>

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="w-64 border-r border-rose-100 bg-white p-4 flex flex-col shrink-0">
        <div className="flex items-center gap-3 px-2 py-2 mb-8">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-sky-500 text-lg font-bold text-white shrink-0">Л</div>
          <div>
            <p className="font-semibold text-slate-900">Лотос</p>
            <p className="text-xs text-slate-500">CRM для бассейна</p>
          </div>
        </div>
        <nav className="flex flex-col gap-2 flex-grow">
          {nav.map((item) => {
            if (store.authStore.user?.role === 'coach' && item.label !== 'Расписание') return null
            return (
              <button
                key={item.label}
                onClick={() => store.setScreen(item.label)}
                className={`flex w-full items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                  store.currentScreen === item.label
                    ? 'bg-cyan-50 text-cyan-700 font-semibold'
                    : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                <item.icon className="size-5 shrink-0" />
                <span className="font-medium">{item.label}</span>
              </button>
            )
          })}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-20 flex h-20 items-center justify-between border-b border-pink-100 bg-white/80 backdrop-blur-md px-6 shadow-sm">
          <div className="flex flex-col">
            <div className="text-2xl font-extrabold text-slate-900 tracking-tight">{store.currentScreen}</div>
          </div>
          
          <div className="flex flex-col items-center">
            <div className="text-sm text-cyan-700 font-semibold mt-0.5">
              {store.currentBranch?.name || 'Все филиалы'} · {new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <select 
              aria-label="Выберите филиал" 
              value={store.selectedBranchId || ''}
              onChange={(e) => store.setBranch(e.target.value)}
              className="h-9 rounded-full border border-cyan-200 bg-cyan-50/50 px-4 text-sm font-semibold text-cyan-900 outline-none focus:ring-2 focus:ring-cyan-400 transition-all hover:bg-cyan-50"
            >
              <option value="">Все филиалы</option>
              {store.branches.map(branch => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>

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

        <Sheet open={store.branchMenuOpen} onOpenChange={store.closeBranchMenu}>
          <SheetContent side="right" className="w-[350px] bg-white border-l border-pink-100 p-0 shadow-2xl">
            <div className="p-6 border-b border-pink-50 bg-gradient-to-b from-cyan-50/50 to-white">
              <SheetTitle className="text-xl font-bold text-cyan-900">Управление филиалами</SheetTitle>
            </div>
            
            <div className="p-6 flex flex-col gap-6">
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Мои филиалы</h3>
                <div className="grid gap-2">
                  {store.branches.map(branch => (
                    <button 
                      key={branch.id} 
                      onClick={() => store.setBranch(String(branch.id))}
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
                    <Input id="new-branch-name" placeholder="Название филиала" className="border-slate-200 focus:border-cyan-400 rounded-lg" />
                    <Input id="new-branch-address" placeholder="Адрес филиала" className="border-slate-200 focus:border-cyan-400 rounded-lg" />
                    {store.error && <p className="text-xs text-rose-500 font-medium">{store.error}</p>}
                    <Button onClick={() => {
                        const name = (document.getElementById('new-branch-name') as HTMLInputElement).value
                        const address = (document.getElementById('new-branch-address') as HTMLInputElement).value
                        if (name && address) store.addBranch(name, address)
                    }} className="w-full rounded-full bg-gradient-to-r from-cyan-500 to-pink-400 text-white font-semibold hover:from-cyan-600 hover:to-pink-500 transition-all shadow-md">
                        Создать филиал
                    </Button>
                </div>
              </div>
            </div>
          </SheetContent>
        </Sheet>

        <main className="p-4 sm:p-6">
          {store.currentScreen === 'Дашборд' && <Dashboard setScreen={store.setScreen} />}
          {store.currentScreen === 'Клиенты и дети' && <ClientsView />}
          {store.currentScreen === 'Расписание' && <ScheduleView />}
          {store.currentScreen === 'Тренеры' && <CoachesView />}
          {store.currentScreen !== 'Дашборд' && store.currentScreen !== 'Клиенты и дети' && store.currentScreen !== 'Расписание' && store.currentScreen !== 'Тренеры' && <div>Раздел «{store.currentScreen}» в разработке</div>}
        </main>
      </div>
    </div>
  )
})

export default Page