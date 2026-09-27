'use client'

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { CalendarPlus, Clock3, UserRound } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useStore } from '@/store/StoreProvider'
import { parseTimeToHHMM } from '@/lib/utils/date'

export const CreateLessonModal = observer(({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
  const store = useStore()
  const [formData, setFormData] = useState({
    date: new Date().toISOString().split('T')[0],
    time: '17:00',
    coachName: store.branchCoaches[0]?.name || '',
    clientId: '',
    category: 'плавание' as 'плавание' | 'синхронное плавание',
  })

  const handleSubmit = async () => {
    // Вычисляем день недели
    const d = new Date(formData.date)
    const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
    const dayOfWeek = days[d.getDay()]

    // Форматируем время в HH:mm через утилиту (поддерживает 18:00, 18.00, 18, 0.75)
    const timeStr = parseTimeToHHMM(formData.time)

    const newLessonData = {
      // НЕ генерируем ID локально - сервер вернет свой ID
      branchId: store.selectedBranchId,
      date: formData.date,
      dayOfWeek: dayOfWeek,
      time: timeStr,
      title: formData.category === 'синхронное плавание' ? 'Синхронное плавание' : 'Плавание',
      coachName: formData.coachName,
      category: formData.category,
      pool: 'Основной бассейн',
      duration: '1 час',
      maxCapacity: 10,
    }

    // createLesson возвращает созданный урок с серверным ID
    const createdLesson = await store.createLesson(newLessonData as any)

    // Используем серверный ID для прикрепления клиента
    if (formData.clientId && createdLesson?.id) {
      await store.clientStore.toggleClientLesson(formData.clientId, createdLesson.id)
    }

    onClose()
    setFormData({
      date: new Date().toISOString().split('T')[0],
      time: '17:00',
      coachName: store.branchCoaches[0]?.name || '',
      clientId: '',
      category: 'плавание',
    })
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[460px] overflow-hidden rounded-[28px] border-0 bg-slate-50 p-0 shadow-2xl">
        <div className="bg-gradient-to-br from-cyan-600 to-sky-700 px-6 py-6 text-white">
          <DialogHeader>
            <div className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-white/15">
              <CalendarPlus className="size-5" />
            </div>
            <DialogTitle className="text-2xl font-bold text-white">Новое занятие</DialogTitle>
            <p className="mt-1 text-sm text-cyan-50">Добавьте занятие в расписание филиала</p>
          </DialogHeader>
        </div>
        <div className="grid gap-4 p-6">
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              <span className="flex items-center gap-1.5">
                <CalendarPlus className="size-3.5 text-cyan-600" />
                Дата
              </span>
              <Input
                type="date"
                value={formData.date}
                onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                className="h-11 rounded-xl bg-white"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              <span className="flex items-center gap-1.5">
                <Clock3 className="size-3.5 text-cyan-600" />
                Время
              </span>
              <Input
                value={formData.time}
                onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                placeholder="17:00"
                className="h-11 rounded-xl bg-white"
              />
            </label>
          </div>

          <Select
            value={formData.category}
            onValueChange={(val) => {
              if (val === 'плавание' || val === 'синхронное плавание') {
                setFormData({ ...formData, category: val })
              }
            }}
          >
            <SelectTrigger className="h-11 w-full rounded-xl bg-white">
              <SelectValue placeholder="Секция" />
            </SelectTrigger>
            <SelectContent className="rounded-xl bg-white">
              <SelectItem value="плавание">🏊 Плавание</SelectItem>
              <SelectItem value="синхронное плавание">🎭 Синхронное плавание</SelectItem>
            </SelectContent>
          </Select>

          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            <span className="flex items-center gap-1.5">
              <UserRound className="size-3.5 text-cyan-600" />
              Тренер
            </span>
            <Select
              value={formData.coachName}
              onValueChange={(val) => val && setFormData({ ...formData, coachName: val })}
            >
              <SelectTrigger className="h-11 w-full rounded-xl bg-white">
                <SelectValue placeholder="Тренер" />
              </SelectTrigger>
              <SelectContent className="rounded-xl bg-white">
                {store.branchCoaches.map((c) => (
                  <SelectItem key={c.id} value={c.name}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            <span className="flex items-center gap-1.5">
              <UserRound className="size-3.5 text-cyan-600" />
              Клиент <em className="font-normal text-slate-400">необязательно</em>
            </span>
            <Select
              value={formData.clientId}
              onValueChange={(val) => setFormData({ ...formData, clientId: val ?? '' })}
            >
              <SelectTrigger className="h-11 w-full rounded-xl bg-white">
                <SelectValue placeholder="Клиент (необязательно)" />
              </SelectTrigger>
              <SelectContent className="rounded-xl bg-white">
                <SelectItem value="">Без клиента</SelectItem>
                {store.branchClients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.childName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <Button
            onClick={handleSubmit}
            className="mt-1 h-12 w-full rounded-xl bg-cyan-600 text-white font-bold shadow-lg shadow-cyan-200 hover:bg-cyan-700"
          >
            Создать
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
})
