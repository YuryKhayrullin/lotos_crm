'use client'

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { getStore } from '@/store/RootStore'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AttendanceModal } from './AttendanceModal'
import { ILesson } from '@/store/models'
import { CalendarDays, Plus } from 'lucide-react'

const store = getStore()

const getStartOfWeek = () => {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const start = new Date(d.setDate(diff));
  start.setHours(0, 0, 0, 0);
  return start;
};

export const ScheduleView = observer(() => {
  const startOfWeek = getStartOfWeek();
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);

  const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label, i) => {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    return { key: label, label: `${label} ${d.getDate()}` };
  });

  const [selectedDay, setSelectedDay] = useState(DAYS[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1].key)
  const [selectedLesson, setSelectedLesson] = useState<ILesson | null>(null)
  const [viewMode, setViewMode] = useState<'день' | 'неделя'>('неделя')

  const lessons = store.sortedBranchLessons.filter(l => viewMode === 'неделя' || l.dayOfWeek === selectedDay)

  const branch = store.currentBranch

  const weekRange = `${startOfWeek.getDate()} ${startOfWeek.toLocaleString('ru-RU', { month: 'short' })} – ${endOfWeek.getDate()} ${endOfWeek.toLocaleString('ru-RU', { month: 'short' })} ${endOfWeek.getFullYear()}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white p-6 rounded-2xl shadow-sm border border-slate-100 gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">
            Расписание · {branch ? branch.name : 'Филиал'}
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Неделя {weekRange} · отдельное расписание филиала
          </p>
        </div>
        <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl">
          <Button 
            variant={viewMode === 'день' ? 'default' : 'ghost'} 
            size="sm"
            onClick={() => setViewMode('день')}
            className={viewMode === 'день' ? 'bg-cyan-500 text-white rounded-lg shadow-sm' : 'text-slate-600 rounded-lg'}
          >
            День
          </Button>
          <Button 
            variant={viewMode === 'неделя' ? 'default' : 'ghost'} 
            size="sm"
            onClick={() => setViewMode('неделя')}
            className={viewMode === 'неделя' ? 'bg-cyan-500 text-white rounded-lg shadow-sm' : 'text-slate-600 rounded-lg'}
          >
            Неделя
          </Button>
        </div>
      </div>

      {/* Горизонтальный селектор дней недели */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2">
        {DAYS.map(d => (
          <button
            key={d.key}
            onClick={() => { setSelectedDay(d.key); setViewMode('день'); }}
            className={`px-5 py-2.5 rounded-2xl font-semibold text-sm transition-all whitespace-nowrap shadow-sm border ${
              viewMode === 'день' && selectedDay === d.key
                ? 'bg-cyan-500 text-white border-cyan-500 shadow-cyan-100'
                : 'bg-white text-slate-700 border-slate-100 hover:border-cyan-200 hover:bg-slate-50'
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      <AttendanceModal 
        isOpen={!!selectedLesson} 
        onClose={() => setSelectedLesson(null)} 
        lesson={selectedLesson} 
      />

      <div className="grid gap-4">
        {lessons.length === 0 ? (
          <Card className="rounded-2xl border-slate-100 shadow-sm p-12 text-center">
            <p className="text-slate-500">Нет занятий на выбранный день</p>
          </Card>
        ) : (
          lessons.map((lesson) => {
            // Подсчет реально записанных детей в филиале на это занятие
            const enrolledCount = store.branchClients.filter(c => c.isAssignedTo(lesson.id)).length
            const maxCap = lesson.maxCapacity || 10
            const countStr = `${enrolledCount} / ${maxCap}`

            return (
              <Card 
                key={lesson.id} 
                className="rounded-2xl border-slate-100 shadow-sm hover:shadow-md transition-all cursor-pointer overflow-hidden group"
                onClick={() => setSelectedLesson(lesson as any)}
              >
                <CardContent className="p-5 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-1.5 h-12 bg-cyan-500 rounded-full group-hover:bg-pink-400 transition-colors" />
                    <div>
                      <p className="text-lg font-bold text-cyan-950">{lesson.time}</p>
                      <p className="text-sm font-semibold text-slate-800 mt-0.5">{lesson.title}</p>
                      <p className="text-xs text-slate-500 mt-1">{lesson.coachName} · {lesson.pool}</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-4">
                    <Badge className="bg-cyan-50 text-cyan-700 font-bold px-3 py-1 text-sm rounded-xl">
                      {countStr}
                    </Badge>
                    <div className="text-slate-400 group-hover:text-cyan-600 transition-colors font-bold text-xl px-2">
                      ›
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })
        )}
      </div>
    </div>
  )
})

