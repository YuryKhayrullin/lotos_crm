'use client'

import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useStore } from '@/store/StoreProvider'
import { apiClient, type ClientsPage } from '@/lib/api-client'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const PAGE_SIZE = 50
const formatCurrency = (amount?: number) => {
  if (amount === undefined || amount === null || isNaN(amount)) return '0 ₽'
  return new Intl.NumberFormat('ru-RU').format(amount) + ' ₽'
}

export const SubscriptionsView = observer(() => {
  const store = useStore()
  const [page, setPage] = useState<ClientsPage>({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE, hasMore: false })
  const [query, setQuery] = useState('')
  const queryText = query.trim()
  const requestVersion = useRef(0)
  const paginationPending = useRef(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const branchId = store.selectedBranchId || undefined

  useEffect(() => {
    const controller = new AbortController()
    const requestGate = requestVersion
    const version = ++requestGate.current
    paginationPending.current = false
    setIsLoading(true)
    setError('')
    const timer = window.setTimeout(
      () => {
        void apiClient
          .getSubscriptionsPage(1, PAGE_SIZE, controller.signal, branchId, queryText || undefined)
          .then((nextPage) => {
            if (!controller.signal.aborted && version === requestVersion.current) setPage(nextPage)
          })
          .catch((requestError) => {
            if (!controller.signal.aborted && version === requestVersion.current)
              setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить абонементы')
          })
          .finally(() => {
            if (!controller.signal.aborted && version === requestVersion.current) setIsLoading(false)
          })
      },
      queryText ? 250 : 0,
    )
    return () => {
      window.clearTimeout(timer)
      controller.abort()
      requestGate.current++
    }
  }, [branchId, queryText])

  const loadNextPage = async () => {
    if (isLoading || paginationPending.current || !page.hasMore) return
    const version = requestVersion.current
    paginationPending.current = true
    setIsLoading(true)
    setError('')
    try {
      const nextPage = await apiClient.getSubscriptionsPage(
        page.page + 1,
        PAGE_SIZE,
        undefined,
        branchId,
        queryText || undefined,
      )
      if (version !== requestVersion.current) return
      setPage((current) => ({ ...nextPage, items: [...current.items, ...nextPage.items] }))
    } catch (requestError) {
      if (version === requestVersion.current)
        setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить абонементы')
    } finally {
      if (version === requestVersion.current) {
        paginationPending.current = false
        setIsLoading(false)
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 bg-white p-6 rounded-2xl shadow-sm border border-slate-100 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Абонементы</h2>
          <p className="mt-1 text-sm text-slate-500">Найдено: {page.total}</p>
        </div>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Найти ребёнка или родителя"
          className="max-w-sm rounded-xl"
        />
      </div>

      {error && (
        <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Не удалось загрузить абонементы
        </p>
      )}
      <Card className="rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ребенок</TableHead>
                <TableHead>Остаток занятий</TableHead>
                <TableHead>Оплаченная сумма</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!isLoading && page.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center py-10 text-slate-500">
                    В этом филиале пока нет клиентов с абонементами
                  </TableCell>
                </TableRow>
              ) : (
                page.items.map((client) => (
                  <TableRow key={client.id} className="hover:bg-slate-50/50">
                    <TableCell className="font-semibold text-slate-900">{client.childName || 'Без имени'}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="bg-cyan-50 text-cyan-700 font-medium rounded-full">
                        {client.subscription?.remainingLessons ?? 0} зан.
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium text-emerald-600 tabular-nums">
                      {formatCurrency(client.paidAmount)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {page.hasMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            className="rounded-full border-cyan-200 text-cyan-700"
            onClick={() => void loadNextPage()}
            disabled={isLoading}
          >
            {isLoading ? 'Загрузка…' : 'Загрузить ещё'}
          </Button>
        </div>
      )}
    </div>
  )
})
