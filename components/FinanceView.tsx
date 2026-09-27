'use client'

import { observer } from 'mobx-react-lite'
import { useStore } from '@/store/StoreProvider'
import { Card, CardContent } from '@/components/ui/card'

const money = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
})

export const FinanceView = observer(() => {
  const store = useStore()
  const clients = store.branchClients
  const paid = clients.reduce((sum, client) => sum + Number(client.paidAmount || 0), 0)
  const lessons = clients.reduce((sum, client) => sum + client.remainingLessons, 0)
  const active = clients.filter((client) => client.isActive).length

  const metrics = [
    { label: 'Оплачено по клиентам', value: money.format(paid), tone: 'text-emerald-600' },
    { label: 'Осталось занятий', value: String(lessons), tone: 'text-cyan-700' },
    { label: 'Активных клиентов', value: String(active), tone: 'text-pink-600' },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Финансы</h2>
        <p className="mt-1 text-sm text-slate-500">Сводка по выбранному филиалу</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {metrics.map((metric) => (
          <Card key={metric.label} className="rounded-2xl border-slate-100 shadow-sm">
            <CardContent className="p-6">
              <p className="text-sm text-slate-500">{metric.label}</p>
              <p className={`mt-3 text-3xl font-extrabold ${metric.tone}`}>{metric.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="rounded-2xl border-slate-100 shadow-sm">
        <CardContent className="p-6 text-sm text-slate-500">
          Показатели рассчитаны по загруженным данным клиентов. Детализация платежей появится после подключения
          отдельного финансового журнала.
        </CardContent>
      </Card>
    </div>
  )
})
