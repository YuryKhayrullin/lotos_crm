'use client'

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useStore } from '@/store/StoreProvider'
import { apiClient } from '@/lib/api-client'
import { parseTimeToHHMM } from '@/lib/utils/date'

export const CreateLessonModal = observer(({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) => {
  const store = useStore()
  const [formData, setFormData] = useState({
    date: new Date().toISOString().split('T')[0],
    time: '17:00',
    title: 'Плавание',
    coachName: store.branchCoaches[0]?.name || '',
    clientId: '',
    category: 'плавание' as 'плавание' | 'синхронное плавание'
  })

  const handleSubmit = async () => {
    // Вычисляем день недели
    const d = new Date(formData.date);
    const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const dayOfWeek = days[d.getDay()];

    // Форматируем время в HH:mm через утилиту (поддерживает 18:00, 18.00, 18, 0.75)
    const timeStr = parseTimeToHHMM(formData.time);

    const newLessonData = {
      // НЕ генерируем ID локально - сервер вернет свой ID
      branchId: store.selectedBranchId,
      date: formData.date,
      dayOfWeek: dayOfWeek,
      time: timeStr,
      title: formData.title,
      coachName: formData.coachName,
      category: formData.category,
      pool: 'Основной бассейн',
      duration: '1 час',
      maxCapacity: 10
    };

    // createLesson возвращает созданный урок с серверным ID
    const createdLesson = await store.createLesson(newLessonData as any);
    
    // Используем серверный ID для прикрепления клиента
    if (formData.clientId && createdLesson?.id) {
      await store.clientStore.toggleClientLesson(formData.clientId, createdLesson.id);
    }
    
    // Перезагружаем ВСЕ данные для синхронизации
    await Promise.all([
        store.initialize(),
        store.clientStore.loadClients()
    ]);
    
    onClose();
    setFormData({
      date: new Date().toISOString().split('T')[0],
      time: '17:00',
      title: 'Плавание',
      coachName: store.branchCoaches[0]?.name || '',
      clientId: '',
      category: 'плавание'
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
          <Input value={formData.time} onChange={e => setFormData({...formData, time: e.target.value})} placeholder="Время (18:00, 18.00, 18)" className="rounded-xl" />
          
          <Select value={formData.title} onValueChange={(val) => val && setFormData({...formData, title: val})}>
            <SelectTrigger className="rounded-xl">
              <SelectValue placeholder="Тип занятия" />
            </SelectTrigger>
            <SelectContent className="rounded-xl bg-white">
              <SelectItem value="Плавание">Плавание</SelectItem>
              <SelectItem value="Синхронное плавание">Синхронное плавание</SelectItem>
            </SelectContent>
          </Select>

          <Select value={formData.category} onValueChange={(val: 'плавание' | 'синхронное плавание') => val && setFormData({...formData, category: val})}>
            <SelectTrigger className="rounded-xl">
              <SelectValue placeholder="Категория" />
            </SelectTrigger>
            <SelectContent className="rounded-xl bg-white">
              <SelectItem value="плавание">🏊 Плавание</SelectItem>
              <SelectItem value="синхронное плавание">🎭 Синхронное плавание</SelectItem>
            </SelectContent>
          </Select>

          <Select value={formData.coachName} onValueChange={(val) => val && setFormData({...formData, coachName: val})}>
            <SelectTrigger className="rounded-xl">
              <SelectValue placeholder="Тренер" />
            </SelectTrigger>
            <SelectContent className="rounded-xl bg-white">
              {store.branchCoaches.map(c => (
                <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          
          <Select value={formData.clientId} onValueChange={(val) => setFormData({...formData, clientId: val})}>
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
