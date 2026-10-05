'use client'

import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useStore } from '@/store/StoreProvider'
import { Card, CardContent } from '@/components/ui/card'
import { apiClient, type FinanceSummary } from '@/lib/api-client'

const money = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
})

export const FinanceView = observer(() => {
  const store = useStore()
  const [summary, setSummary] = useState<FinanceSummary | null>(null)
  const [error, setError] = useState('')
  const branchId = store.selectedBranchId || undefined

  useEffect(() => {
    const controller = new AbortController()
    setSummary(null)
    setError('')
    void apiClient
      .getFinanceSummary(controller.signal, branchId)
      .then((data) => {
        if (!controller.signal.aborted) setSummary(data)
      })
      .catch((requestError) => {
        if (!controller.signal.aborted)
          setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить финансы')
      })
    return () => controller.abort()
  }, [branchId])

  const metrics = summary
    ? [
        { label: 'Оплачено по клиентам', value: money.format(summary.totalPaidAmount), tone: 'text-emerald-600' },
        { label: 'Осталось занятий', value: String(summary.remainingLessons), tone: 'text-cyan-700' },
        { label: 'Активных клиентов', value: String(summary.activeClients), tone: 'text-cyan-700' },
      ]
    : []

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-3xl bg-gradient-to-br from-[#103c4a] via-[#0c5265] to-[#078b9e] p-6 text-white sm:p-7">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200">Финансовый учёт</p>
        <h2 className="text-2xl font-semibold tracking-tight">{store.currentBranch?.name || 'Все филиалы'}</h2>
        <p className="mt-2 text-sm text-cyan-50/80">Оплаты и остатки занятий по всей выборке клиентов</p>
      </div>
      {error && (
        <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Не удалось загрузить сводку финансов
        </p>
      )}
      {!summary && !error && <p className="text-sm text-slate-500">Загрузка финансовой сводки…</p>}
      {summary && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {metrics.map((metric) => (
              <Card key={metric.label} className="rounded-2xl border border-slate-200/80 bg-white ring-0 shadow-none">
                <CardContent className="p-6">
                  <p className="text-sm text-slate-500">{metric.label}</p>
                  <p className={`mt-3 text-3xl font-semibold tracking-tight ${metric.tone}`}>{metric.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          <Card className="rounded-3xl border border-slate-200/80 bg-white ring-0 shadow-none">
            <CardContent className="p-6 text-sm text-slate-500">
              Учтено клиентов: {summary.totalClients}. В том числе на паузе: {summary.pausedClients}, в архиве:{' '}
              {summary.archivedClients}. Показатели рассчитываются на сервере по всей выборке, а не по открытой странице
              клиентов.
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
})
