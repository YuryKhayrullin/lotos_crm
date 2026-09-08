'use client'

import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { getStore } from '@/store/RootStore'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Plus } from 'lucide-react'

const store = getStore()

const formatPhone = (value: string) => {
  const phone = value.replace(/\D/g, '').slice(0, 11)
  if (!phone) return ''
  if (phone.length === 1) return `+7 (${phone.replace('7', '')}`
  if (phone.length < 5) return `+7 (${phone.slice(1)}`
  if (phone.length < 8) return `+7 (${phone.slice(1, 4)}) ${phone.slice(4)}`
  if (phone.length < 10) return `+7 (${phone.slice(1, 4)}) ${phone.slice(4, 7)}-${phone.slice(7)}`
  return `+7 (${phone.slice(1, 4)}) ${phone.slice(4, 7)}-${phone.slice(7, 9)}-${phone.slice(9)}`
}

const formatBirthDate = (value: string) => {
  return value
    .replace(/\D/g, '')
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/\.(\d{2})(\d)/, '.$1.$2')
    .slice(0, 10)
}

export const CoachesView = observer(() => {
  const coaches = store.branchCoaches
  const [isAddCoachOpen, setIsAddCoachOpen] = useState(false)
  const [formData, setFormData] = useState({ name: '', surname: '', phone: '', birthDate: '' })

  const handleSubmit = async () => {
    const fullName = `${formData.name} ${formData.surname}`.trim()
    store.setCoachFormName(fullName)
    store.setCoachFormSpecialty('Тренер')
    await store.createCoach()
    setIsAddCoachOpen(false)
    setFormData({ name: '', surname: '', phone: '', birthDate: '' })
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Тренеры</h2>
        <Dialog open={isAddCoachOpen} onOpenChange={setIsAddCoachOpen}>
          <DialogTrigger className="rounded-full bg-cyan-100 hover:bg-cyan-200 text-cyan-800 shadow-sm transition-all px-4 py-2 text-sm inline-flex items-center justify-center font-medium">
              <Plus className="mr-2 size-4" /> Добавить тренера
          </DialogTrigger>
          <DialogContent className="max-w-[450px] p-0 rounded-3xl overflow-hidden border-pink-100 bg-white">
             <DialogHeader className="p-8 border-b border-pink-50 bg-gradient-to-br from-cyan-50 via-white to-pink-50/50">
              <DialogTitle className="text-2xl font-extrabold text-cyan-950 tracking-tight">Новый тренер</DialogTitle>
            </DialogHeader>
            <div className="grid gap-5 p-8">
              <Input placeholder="Имя" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400" />
              <Input placeholder="Фамилия" value={formData.surname} onChange={e => setFormData({...formData, surname: e.target.value})} className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400" />
              <Input placeholder="+7 (000) 000-00-00" value={formData.phone} onChange={e => setFormData({...formData, phone: formatPhone(e.target.value)})} className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400" />
              <Input placeholder="ДД.ММ.ГГГГ" value={formData.birthDate} onChange={e => setFormData({...formData, birthDate: formatBirthDate(e.target.value)})} maxLength={10} className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400" />
              <Button onClick={handleSubmit} className="w-full rounded-full bg-cyan-500 hover:bg-cyan-600 text-white font-bold h-12 shadow-lg transition-all">
                Сохранить
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {coaches.length === 0 ? (
          <p className="col-span-full text-center py-10 text-slate-500">В этом филиале пока нет тренеров</p>
        ) : (
          coaches.map((coach) => (
            <Card key={coach.id} className="rounded-2xl border-cyan-100 hover:shadow-md transition-shadow">
              <CardContent className="p-6 flex items-center gap-4">
                <div className="size-16 rounded-full bg-gradient-to-tr from-cyan-100 to-pink-100 flex items-center justify-center text-xl font-bold text-cyan-700">
                  {coach.initials}
                </div>
                <div>
                  <h3 className="font-bold text-lg text-slate-900">{coach.name}</h3>
                  <p className="text-sm text-slate-500">{coach.specialty}</p>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
})
