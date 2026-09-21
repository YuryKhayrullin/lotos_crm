'use client'

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { useStore } from '@/store/StoreProvider'
import { ILesson } from '@/store/models'
import { Check, XCircle, Loader2, Plus, Minus, UserPlus, Save, CheckCheck } from 'lucide-react'

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
  const [attendance, setAttendance] = useState<Record<string, 'attended' | 'absent' | 'walkin'>>({})
  const [saving, setSaving] = useState(false)

  if (!lesson) return null

  // Все подходящие клиенты филиала: активные + есть занятия на абонементе + (категория совпадает ИЛИ у урока нет категории)
  const eligibleClients = store.branchClients.filter(c => {
    if (!c.isActive) return false
    if (c.remainingLessons <= 0) return false
    if (lesson.category && c.category && c.category !== lesson.category) return false
    return true
  })

  const handleToggle = (clientId: string, status: 'attended' | 'absent' | 'walkin') => {
    setAttendance(prev => ({
      ...prev,
      [clientId]: prev[clientId] === status ? null : status
    }))
  }

  const handleSaveAll = async () => {
    if (Object.keys(attendance).length === 0) return
    
    setSaving(true)
    try {
      const attendanceList = Object.entries(attendance).map(([clientId, status]) => ({
        clientId,
        status: status === 'walkin' ? 'attended' : status, // walkin считается как attended на бэке, но не списываем
        isWalkin: status === 'walkin'
      }))

      // Используем bulk метод
      await store.clientStore.markBulkAttendance(
        attendanceList.filter(a => !a.isWalkin).map(({clientId, status}) => ({clientId, status})),
        lesson.id,
        lesson.date || new Date().toISOString().split('T')[0]
      )

      // Для walkin просто закрываем, списания нет
      onClose()
    } catch (err) {
      console.error(err)
      alert('Ошибка при сохранении посещаемости')
    } finally {
      setSaving(false)
    }
  }

  const attendedCount = Object.values(attendance).filter(v => v === 'attended').length
  const absentCount = Object.values(attendance).filter(v => v === 'absent').length
  const walkinCount = Object.values(attendance).filter(v => v === 'walkin').length

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[600px] rounded-3xl p-6 bg-white max-h-[90vh] overflow-y-auto">
        <DialogHeader className="border-b border-slate-100 pb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <DialogTitle className="text-xl font-bold text-cyan-950">
              {lesson.title} · {lesson.time}
            </DialogTitle>
            <p className="text-sm text-slate-500 mt-1">
              {lesson.coachName} · {lesson.category} · {eligibleClients.length} доступных учеников
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-sm font-medium">
              <Check className="inline size-3 mr-1" /> {attendedCount}
            </span>
            <span className="px-3 py-1 bg-rose-100 text-rose-700 rounded-full text-sm font-medium">
              <XCircle className="inline size-3 mr-1" /> {absentCount}
            </span>
            <span className="px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-sm font-medium">
              <UserPlus className="inline size-3 mr-1" /> {walkinCount}
            </span>
            <Button 
              onClick={handleSaveAll} 
              disabled={saving || Object.keys(attendance).length === 0}
              className="bg-cyan-600 hover:bg-cyan-700 rounded-xl px-4 h-10"
            >
              {saving ? <Loader2 className="animate-spin size-4" /> : <> <Save className="mr-2 size-4" /> Сохранить всё </>}
            </Button>
          </div>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {eligibleClients.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-slate-500">Нет подходящих учеников</p>
              <p className="text-xs text-slate-400 mt-1">Проверьте: статус «Активен», есть занятия на абонементе, категория совпадает</p>
            </div>
          ) : (
            <div className="grid gap-3 max-h-[60vh] overflow-y-auto pr-2">
              {eligibleClients.map(client => {
                const markState = attendance[client.id]
                const isAttended = markState === 'attended'
                const isAbsent = markState === 'absent'
                const isWalkin = markState === 'walkin'
                
                const cardBg = isAttended ? 'bg-emerald-50 border-emerald-200' : 
                               isAbsent ? 'bg-rose-50 border-rose-200' : 
                               isWalkin ? 'bg-amber-50 border-amber-200' : 
                               'bg-white border-slate-100'

                return (
                  <Card key={client.id} className={`p-4 rounded-2xl border ${cardBg} shadow-sm transition-all`}>
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-bold text-slate-900 text-lg">{client.childName}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant={client.remainingLessons > 0 ? "outline" : "destructive"} className="text-xs">
                          {client.remainingLessons > 0 ? `${client.remainingLessons} зан.` : "Долг"}
                        </Badge>
                        <Badge variant="secondary" className="text-xs bg-slate-100 text-slate-600">
                          {client.category}
                        </Badge>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <Button 
                        onClick={() => handleToggle(String(client.id), 'attended')}
                        disabled={saving}
                        className={`h-12 text-sm font-bold rounded-xl transition-all ${isAttended ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-emerald-500 hover:bg-emerald-600'}`}
                      >
                        <Check className="mr-1.5 size-3.5" /> Был
                      </Button>
                      <Button 
                        onClick={() => handleToggle(String(client.id), 'absent')}
                        disabled={saving}
                        className={`h-12 text-sm font-bold rounded-xl transition-all ${isAbsent ? 'bg-rose-600 hover:bg-rose-700' : 'bg-rose-500 hover:bg-rose-600'}`}
                      >
                        <XCircle className="mr-1.5 size-3.5" /> Пропуск
                      </Button>
                      <Button 
                        onClick={() => handleToggle(String(client.id), 'walkin')}
                        disabled={saving}
                        variant="outline"
                        className={`h-12 text-sm font-bold rounded-xl transition-all ${isWalkin ? 'bg-amber-600 hover:bg-amber-700 text-white border-amber-600' : 'bg-amber-50 hover:bg-amber-100 border-amber-200 text-amber-700'}`}
                      >
                        <UserPlus className="mr-1.5 size-3.5" /> Проходное
                      </Button>
                    </div>
                  </Card>
                )
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
})
