'use client'

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useStore } from '@/store/StoreProvider'

export const CreateLessonModal = observer(({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) => {
  const store = useStore()
  const [formData, setFormData] = useState({
    date: new Date().toISOString().split('T')[0],
    time: '17:00',
    title: 'Плавание',
    coachName: store.branchCoaches[0]?.name || '',
    clientId: ''
  })

  const handleSubmit = async () => {
    const newLessonId = String(Date.now());
    const newLessonData = {
      id: newLessonId,
      branchId: store.selectedBranchId,
      date: formData.date,
      time: formData.time,
      title: formData.title,
      coachName: formData.coachName,
      pool: 'Основной бассейн',
      duration: '1 час',
      maxCapacity: 10
    };

    await store.createLesson(newLessonData as any);
    
    if (formData.clientId) {
      await store.clientStore.toggleClientLesson(formData.clientId, newLessonId);
    }
    
    onClose();
    setFormData({
      date: new Date().toISOString().split('T')[0],
      time: '17:00',
      title: 'Плавание',
      coachName: store.branchCoaches[0]?.name || '',
      clientId: ''
    });
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[400px] p-6 rounded-3xl bg-white border-cyan-100 shadow-2xl">
        <DialogHeader className="pb-4 border-b border-cyan-50">
          <DialogTitle className="text-xl font-bold text-cyan-950">Новое занятие</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <Input type="date" value={formData.date} onChange={e => setFormData({...formData, date: e.target.value})} className="rounded-xl" />
          <Input value={formData.time} onChange={e => setFormData({...formData, time: e.target.value})} placeholder="Время (например, 17:00)" className="rounded-xl" />
          <Input value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} placeholder="Название" className="rounded-xl" />
          <Input value={formData.coachName} onChange={e => setFormData({...formData, coachName: e.target.value})} placeholder="Тренер" className="rounded-xl" />
          
          <Select value={formData.clientId} onValueChange={val => setFormData({...formData, clientId: val})}>
            <SelectTrigger className="rounded-xl">
              <SelectValue placeholder="Клиент (необязательно)" />
            </SelectTrigger>
            <SelectContent className="rounded-xl bg-white">
              <SelectItem value="">Без клиента</SelectItem>
              {store.branchClients.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.childName}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button onClick={handleSubmit} className="w-full rounded-xl bg-cyan-500 hover:bg-cyan-600 text-white font-bold h-12">
            Создать
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
})
