'use client'

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { useStore } from '@/store/StoreProvider'
import { ILesson } from '@/store/models'
import { Check, UserPlus, XCircle, ChevronDown, Loader2 } from 'lucide-react'

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
  const [loadingStates, setLoadingStates] = useState<Record<string, boolean>>({})
  const [isUnassignedOpen, setIsUnassignedOpen] = useState(false)

  if (!lesson) return null

  const lessonClients = store.branchClients.filter(c => c.isAssignedTo(lesson.id))
  const unassignedClients = store.branchClients.filter(c => !c.isAssignedTo(lesson.id))

  const handleMark = async (clientId: string, status: 'attended' | 'absent') => {
    setLoadingStates(prev => ({ ...prev, [`${clientId}-${status}`]: true }))
    try {
      await store.clientStore.markAttendance(String(clientId), String(lesson.id), status)
      setMarkedClients(prev => ({ ...prev, [clientId]: status }))
    } catch (err) {
      console.error(err)
    } finally {
      setLoadingStates(prev => ({ ...prev, [`${clientId}-${status}`]: false }))
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[500px] rounded-3xl p-6 bg-white max-h-[90vh] overflow-y-auto">
        <DialogHeader className="border-b border-slate-100 pb-4">
          <DialogTitle className="text-xl font-bold text-cyan-950">
            {lesson.title} · {lesson.time}
          </DialogTitle>
          <p className="text-sm text-slate-500 mt-1">
            {lesson.coachName} · {lessonClients.length} учеников
          </p>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-3">
            {lessonClients.map(client => {
              const markState = markedClients[client.id]
              const isAttended = markState === 'attended'
              const isAbsent = markState === 'absent'
              
              const cardBg = isAttended ? 'bg-emerald-50 border-emerald-200' : isAbsent ? 'bg-rose-50 border-rose-200' : 'bg-white border-slate-100'

              return (
                <Card key={client.id} className={`p-4 rounded-2xl border ${cardBg} shadow-sm transition-all`}>
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-bold text-slate-900 text-lg">{client.childName}</span>
                    <Badge variant={client.remainingLessons > 0 ? "outline" : "destructive"}>
                      {client.remainingLessons > 0 ? `${client.remainingLessons} зан.` : "Долг"}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Button 
                      onClick={() => handleMark(String(client.id), 'attended')}
                      disabled={loadingStates[`${client.id}-attended`] || store.clientStore.isLoading}
                      className={`h-14 text-base font-bold rounded-xl ${isAttended ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-emerald-500 hover:bg-emerald-600'}`}
                    >
                      {loadingStates[`${client.id}-attended`] ? <Loader2 className="animate-spin" /> : <><Check className="mr-2" /> Был</>}
                    </Button>
                    <Button 
                      onClick={() => handleMark(String(client.id), 'absent')}
                      disabled={loadingStates[`${client.id}-absent`] || store.clientStore.isLoading}
                      className={`h-14 text-base font-bold rounded-xl ${isAbsent ? 'bg-rose-600 hover:bg-rose-700' : 'bg-rose-500 hover:bg-rose-600'}`}
                    >
                      {loadingStates[`${client.id}-absent`] ? <Loader2 className="animate-spin" /> : <><XCircle className="mr-2" /> Пропуск</>}
                    </Button>
                  </div>
                </Card>
              )
            })}
          </div>

          {unassignedClients.length > 0 && (
            <div className="pt-4 border-t border-slate-100">
              <button onClick={() => setIsUnassignedOpen(!isUnassignedOpen)} className="flex items-center justify-between w-full text-sm font-semibold text-slate-600 hover:text-cyan-600">
                Записать еще ученика <ChevronDown className={`size-4 transition-transform ${isUnassignedOpen ? 'rotate-180' : ''}`} />
              </button>
              {isUnassignedOpen && (
                <div className="pt-3 grid gap-2 max-h-60 overflow-y-auto">
                  {unassignedClients.map(client => (
                    <div key={client.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100">
                      <p className="font-semibold text-sm">{client.childName}</p>
                      <Button 
                        onClick={() => store.clientStore.toggleClientLesson(String(client.id), String(lesson.id))}
                        size="sm" variant="ghost" className="text-cyan-600"
                      >
                        <UserPlus className="size-4 mr-1.5" /> Записать
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
})

