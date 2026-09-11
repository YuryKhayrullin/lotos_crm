'use client'

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useStore } from '@/store/StoreProvider'
import { ILesson } from '@/store/models'

export const AttendanceSidebar = observer(({ 
  isOpen, 
  onClose, 
  lesson 
}: { 
  isOpen: boolean, 
  onClose: () => void, 
  lesson: ILesson | null 
}) => {
  const store = useStore()
  const [presentClients, setPresentClients] = useState<Record<string, boolean>>({})

  if (!lesson) return null

  const lessonClients = store.clientStore.clients.filter(
    client => client.assignedLessonIds.includes(lesson.id)
  )

  const togglePresent = (clientId: string) => {
    setPresentClients(prev => ({ ...prev, [clientId]: !prev[clientId] }))
  }

  const handleSave = async () => {
    const attendanceList = lessonClients.map(client => ({
      clientId: client.id,
      status: (presentClients[client.id] ? 'attended' : 'absent') as 'attended' | 'absent'
    }))
    await store.clientStore.markBulkAttendance(attendanceList, lesson.id, new Date().toLocaleDateString())
    onClose()
  }

  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent className="w-[400px] sm:w-[540px]">
        <SheetHeader>
          <SheetTitle>Отметка: {lesson.title}</SheetTitle>
        </SheetHeader>
        <div className="grid gap-4 py-6">
          {lessonClients.map(client => {
            const remaining = client.remainingLessons
            const isPresent = !!presentClients[client.id]
            const isBlocked = remaining <= 0

            return (
              <div key={client.id} className="flex items-center justify-between p-4 border rounded-xl hover:bg-slate-50 transition-colors">
                <div className="flex flex-col">
                  <span className="font-semibold">{client.childName}</span>
                  <Badge className={remaining > 0 ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}>
                    {remaining > 0 ? `Занятий: ${remaining}` : "Нужна оплата"}
                  </Badge>
                </div>
                <Button 
                  onClick={() => togglePresent(client.id)}
                  disabled={isBlocked && !isPresent}
                  variant={isPresent ? "default" : "outline"}
                >
                  {isPresent ? "Присутствует" : "Отметить"}
                </Button>
              </div>
            )
          })}
        </div>
        <div className="pt-4 border-t">
          <Button onClick={handleSave} className="w-full h-12 text-lg">
            Сохранить посещаемость
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
})
