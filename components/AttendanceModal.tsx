'use client'

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { useStore } from '@/store/StoreProvider'
import { ILesson } from '@/store/models'
import { Check, UserPlus, XCircle } from 'lucide-react'

export const AttendanceModal = observer(({ 
  isOpen, 
  onClose, 
  lesson 
}: { 
  isOpen: boolean, 
  onClose: () => void, 
  lesson: ILesson | null 
}) => {
  const store = useStore()
  const [markedClients, setMarkedClients] = useState<Record<string, 'attended' | 'absent'>>({})

  if (!lesson) return null

  const lessonClients = store.branchClients.filter(c => c.isAssignedTo(lesson.id))
  const unassignedClients = store.branchClients.filter(c => !c.isAssignedTo(lesson.id))

  const handleMark = async (clientId: string, status: 'attended' | 'absent') => {
    try {
      await store.clientStore.markAttendance(String(clientId), String(lesson.id), status)
      setMarkedClients(prev => ({ ...prev, [clientId]: status }))
    } catch (err) {
      console.error(err)
    }
  }

  const getBadgeStyle = (rem: number) => {
    if (rem > 2) return "bg-emerald-100 text-emerald-700"
    if (rem > 0) return "bg-amber-100 text-amber-700"
    return "bg-rose-100 text-rose-700"
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[480px] rounded-3xl p-6 bg-white max-h-[85vh] overflow-y-auto">
        <DialogHeader className="border-b border-slate-100 pb-4">
          <DialogTitle className="text-xl font-bold text-cyan-950">
            {lesson.title} · {lesson.time}
          </DialogTitle>
          <p className="text-sm text-slate-500 mt-1">
            Тренер: {lesson.coachName} ({lesson.pool}) · Записано: {lessonClients.length} детей
          </p>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">Список учеников</h3>
          {lessonClients.length === 0 ? (
            <p className="text-sm text-slate-500 py-4 text-center">Нет записанных детей</p>
          ) : (
            <div className="grid gap-3">
              {lessonClients.map(client => {
                const rem = client.remainingLessons
                const markState = markedClients[client.id]
                const isAttended = markState === 'attended'
                const isAbsent = markState === 'absent'
                const isDisabled = rem <= 0 && !isAttended

                return (
                  <Card key={client.id} className="p-4 flex items-center justify-between rounded-2xl border-slate-100 shadow-sm">
                    <div>
                      <span className="font-bold text-slate-900">{client.childName}</span>
                      <Badge className={`w-fit mt-1.5 font-medium ${getBadgeStyle(rem)}`}>
                        {rem > 0 ? `Осталось: ${rem} зан.` : "Нужна оплата"}
                      </Badge>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button 
                        onClick={() => handleMark(String(client.id), 'attended')}
                        disabled={isDisabled || isAttended || store.clientStore.isLoading}
                        size="sm"
                        variant={isAttended ? "default" : "outline"}
                        className={isAttended ? "bg-emerald-500 hover:bg-emerald-600 text-white border-emerald-500" : "border-emerald-200 text-emerald-700"}
                      >
                        <Check className="size-4 mr-1" /> {isAttended ? "Был" : "Пришел"}
                      </Button>
                      <Button 
                        onClick={() => handleMark(String(client.id), 'absent')}
                        disabled={isAbsent || store.clientStore.isLoading}
                        size="sm"
                        variant={isAbsent ? "default" : "outline"}
                        className={isAbsent ? "bg-rose-500 hover:bg-rose-600 text-white" : "border-rose-200 text-rose-700"}
                      >
                        <XCircle className="size-4 mr-1" /> Пропуск
                      </Button>
                    </div>
                  </Card>
                )
              })}
            </div>
          )}

          {unassignedClients.length > 0 && (
            <div className="pt-4 border-t border-slate-100">
              <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider mb-3">Записать ученика</h3>
              <div className="grid gap-2 max-h-40 overflow-y-auto">
                {unassignedClients.map(client => (
                  <div key={client.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100">
                    <div>
                      <p className="font-semibold text-sm text-slate-800">{client.childName}</p>
                      <p className="text-xs text-slate-500">Остаток: {client.remainingLessons} зан.</p>
                    </div>
                    <Button 
                      onClick={() => store.clientStore.toggleClientLesson(String(client.id), String(lesson.id))}
                      size="sm" 
                      variant="ghost" 
                      className="text-cyan-600 font-semibold"
                    >
                      <UserPlus className="size-4 mr-1.5" /> Записать
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
})

