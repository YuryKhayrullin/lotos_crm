'use client'

import { observer } from 'mobx-react-lite'
import { getStore } from '@/store/RootStore'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const store = getStore()

export const ScheduleView = observer(() => {
  const lessons = store.sortedBranchLessons

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Расписание</h2>
      </div>

      <Card className="rounded-2xl border-slate-100 shadow-sm">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-100">
                <TableHead>Время</TableHead>
                <TableHead>Занятие</TableHead>
                <TableHead>Тренер</TableHead>
                <TableHead>Бассейн</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lessons.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-10 text-slate-500">Нет занятий на сегодня</TableCell>
                </TableRow>
              ) : (
                lessons.map((lesson) => (
                  <TableRow key={lesson.id} className="border-slate-100 hover:bg-slate-50">
                    <TableCell className="font-semibold text-cyan-700">{lesson.time}</TableCell>
                    <TableCell className="font-medium text-slate-900">{lesson.title}</TableCell>
                    <TableCell className="text-slate-600">{lesson.coachName}</TableCell>
                    <TableCell className="text-slate-600">{lesson.pool}</TableCell>
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
