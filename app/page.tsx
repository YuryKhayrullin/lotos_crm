'use client'

import { observer } from 'mobx-react-lite'
import { useEffect } from 'react'
import { getStore } from '@/store/RootStore'
import { LayoutDashboard, CalendarDays, UsersRound, UserRound, CreditCard, CircleDollarSign, Menu, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ClientsView } from '@/components/ClientsView'
import { ScheduleView } from '@/components/ScheduleView'
import { CoachesView } from '@/components/CoachesView'
import { LoginPage } from '@/components/LoginPage'

const store = getStore()

const nav = [
  { label: 'Дашборд', icon: LayoutDashboard },
  { label: 'Расписание', icon: CalendarDays },
  { label: 'Клиенты и дети', icon: UsersRound },
  { label: 'Тренеры', icon: UserRound },
  { label: 'Абонементы', icon: CreditCard },
  { label: 'Финансы', icon: CircleDollarSign }
]

const Dashboard = observer(({ setScreen }: { setScreen: (s: string) => void }) => {
  const branch = store.currentBranch
  if (!branch) return (
    <div className="flex items-center justify-center h-64 text-slate-500">
      Выберите филиал для просмотра данных
    </div>
  )
  
  const stats = [
    { label: 'Клиенты', value: store.branchClients.length, color: 'text-cyan-600' },
    { label: 'Занятий сегодня', value: store.branchLessons.length, color: 'text-pink-500' },
    { label: 'Тренеры', value: store.branchCoaches.length, color: 'text-emerald-500' },
    { label: 'Выручка (мес)', value: '—', color: 'text-amber-500' },
  ]

  return (
    <div className="flex flex-col gap-8">
      {/* Статистика */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat, i) => (
          <Card key={i} className="rounded-2xl border-pink-50 shadow-sm hover:shadow-md transition-shadow">
            <CardContent className="p-6">
              <p className="text-sm font-medium text-slate-500">{stat.label}</p>
              <p className={`text-3xl font-extrabold mt-2 ${stat.color}`}>{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Расписание и тренеры */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="rounded-2xl border-slate-100 shadow-sm">
          <CardHeader className="p-6 border-b border-slate-50">
            <CardTitle className="text-lg font-bold text-slate-900">Расписание на сегодня</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {store.sortedBranchLessons.length === 0 ? (
              <p className="p-6 text-sm text-slate-500">Нет занятий</p>
            ) : (
              <div className="divide-y divide-slate-50">
                {store.sortedBranchLessons.map(lesson => (
                  <div key={lesson.id} className="p-4 flex items-center justify-between hover:bg-slate-50">
                    <div>
                      <p className="font-semibold text-slate-900">{lesson.title}</p>
                      <p className="text-sm text-slate-500">{lesson.coachName}</p>
                    </div>
                    <Badge variant="secondary" className="bg-cyan-50 text-cyan-700">{lesson.time}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-slate-100 shadow-sm">
          <CardHeader className="p-6 border-b border-slate-50">
            <CardTitle className="text-lg font-bold text-slate-900">Тренеры филиала</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
             <div className="grid grid-cols-2 gap-4">
                {store.branchCoaches.map(coach => (
                    <div key={coach.id} className="flex items-center gap-3 p-3 rounded-xl bg-slate-50">
                        <div className="size-10 rounded-full bg-pink-100 flex items-center justify-center font-bold text-pink-700 text-xs">
                            {coach.initials}
                        </div>
                        <div className="text-sm font-medium text-slate-900 truncate">{coach.name}</div>
                    </div>
                ))}
             </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
})

const Page = observer(() => {
  if (!store.authStore.isAuthenticated) {
    return <LoginPage />
  }

  if (store.isLoading) return <div className="flex min-h-screen items-center justify-center">Загрузка...</div>

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Левая навигация */}
      <aside className={`fixed inset-y-0 left-0 z-30 flex flex-col border-r border-rose-100 bg-white p-4 transition-all duration-300 ${store.sidebarOpen ? 'w-64 translate-x-0' : '-translate-x-full lg:translate-x-0 lg:w-20'}`}>
        <div className="flex items-center gap-3 px-2 py-2 mb-8">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-sky-500 text-lg font-bold text-white shrink-0">Л</div>
          <div className={`${!store.sidebarOpen && 'lg:hidden'}`}>
            <p className="font-semibold">Лотос</p>
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
                className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                  store.currentScreen === item.label
                    ? 'bg-cyan-50 text-cyan-700 font-semibold'
                    : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                <item.icon className="size-5 shrink-0" />
                <span className={`${!store.sidebarOpen && 'lg:hidden'}`}>{item.label}</span>
              </button>
            )
          })}
        </nav>
      </aside>

      {/* Основной контент */}
      <div className={`transition-all duration-300 ${store.sidebarOpen ? 'lg:pl-64' : 'lg:pl-20'}`}>
        {/* Верхний хедер */}
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-pink-100 bg-white/80 backdrop-blur-md px-6 shadow-sm">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => store.toggleSidebar()}>
            <Menu className="size-5" />
          </Button>
          <div className="text-xl font-bold text-slate-800 tracking-tight">{store.currentScreen}</div>
          <div className="flex items-center gap-4">
            <select 
              aria-label="Выберите филиал" 
              value={store.selectedBranchId || ''}
              onChange={(e) => store.setBranch(e.target.value)}
              className="h-9 rounded-full border border-cyan-200 bg-cyan-50/50 px-4 text-sm font-semibold text-cyan-900 outline-none focus:ring-2 focus:ring-cyan-400 transition-all hover:bg-cyan-50"
            >
              {store.branches.map(branch => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>

            {store.authStore.isAuthenticated ? (
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-slate-700">{store.authStore.user?.username}</span>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => store.authStore.logout()} 
                  className="rounded-full h-9 border-cyan-100 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 transition-colors"
                >
                  Выйти
                </Button>
              </div>
            ) : (
              <button className="relative group flex items-center justify-center size-9 rounded-full bg-gradient-to-tr from-cyan-400 to-pink-300 p-[2px] transition-transform hover:scale-105">
                <span className="flex size-full items-center justify-center rounded-full bg-white text-[10px] font-bold text-cyan-600 group-hover:bg-cyan-50 transition-colors">Вход</span>
              </button>
            )}
            
            <Button variant="ghost" size="icon" onClick={() => store.toggleBranchMenu()} className="rounded-full text-slate-500 hover:text-cyan-600">
              <Menu className="size-5" />
            </Button>
          </div>
        </header>

        {/* Меню филиалов (справа) */}
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
                      onClick={() => store.setBranch(branch.id)}
                      className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
                        store.selectedBranchId === branch.id 
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
