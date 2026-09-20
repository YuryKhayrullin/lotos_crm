'use client'

import { observer } from 'mobx-react-lite'
import { useStore } from '@/store/StoreProvider'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

const formatCurrency = (amount?: number) => {
  if (amount === undefined || amount === null || isNaN(amount)) return '0 ₽';
  return new Intl.NumberFormat('ru-RU').format(amount) + ' ₽';
};

export const SubscriptionsView = observer(() => {
  const store = useStore()
  const clients = store.branchClients

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Абонементы</h2>
      </div>
      
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
              {clients.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center py-10 text-slate-500">
                    В этом филиале пока нет клиентов с абонементами
                  </TableCell>
                </TableRow>
              ) : (
                clients.map((client) => (
                  <TableRow key={client.id} className="hover:bg-slate-50/50">
                    <TableCell className="font-semibold text-slate-900">{client.childName || 'Без имени'}</TableCell>
                    <TableCell>
                        <Badge variant="secondary" className="bg-cyan-50 text-cyan-700 font-medium rounded-full">
                            {client.remainingLessons ?? 0} зан.
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
    </div>
  )
})
