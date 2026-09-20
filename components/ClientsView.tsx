'use client'

import { observer } from 'mobx-react-lite'
import { useStore } from '@/store/StoreProvider'
import { useState } from 'react'
import { CreateClientDto, IBranch, IClient } from '@/store/models'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Plus } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SubscriptionUpload } from './SubscriptionUpload'
import { AdminAddLessons } from './AdminAddLessons'

const PRICE_LIST: Record<string, Record<number, number>> = {
  'синхронное плавание': { 3: 15000, 2: 12000, 1: 7000 },
  'плавание': { 3: 10000, 2: 8000, 1: 5500 }
};

const calculateAge = (birthDate: string) => {
  const [day, month, year] = birthDate.split('.').map(Number)
  if (!day || !month || !year) return '0 лет'
  const today = new Date()
  let age = today.getFullYear() - year
  const m = today.getMonth() + 1 - month
  if (m < 0 || (m === 0 && today.getDate() < day)) age--
  return `${age} лет`
}

const formatBirthDate = (value: string) => {
  return value
    .replace(/\D/g, '')
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/\.(\d{2})(\d)/, '.$1.$2')
    .slice(0, 10)
}

const formatPhone = (value: string) => {
  const phone = value.replace(/\D/g, '').slice(0, 11)
  if (!phone) return ''
  if (phone.length === 1) return `+7 (${phone.replace('7', '')}`
  if (phone.length < 5) return `+7 (${phone.slice(1)}`
  if (phone.length < 8) return `+7 (${phone.slice(1, 4)}) ${phone.slice(4)}`
  if (phone.length < 10) return `+7 (${phone.slice(1, 4)}) ${phone.slice(4, 7)}-${phone.slice(7)}`
  return `+7 (${phone.slice(1, 4)}) ${phone.slice(4, 7)}-${phone.slice(7, 9)}-${phone.slice(9)}`
}

export const ClientsView = observer(() => {
  const store = useStore()
  const clients = store.branchClients
  const [isAddClientOpen, setIsAddClientOpen] = useState(false)
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false)
  const [scheduleForm, setScheduleForm] = useState({
    dayOfWeek: 'Вт',
    date: new Date().toISOString().split('T')[0],
    time: '17:00',
    duration: '1 час',
    title: 'Плавание',
    coachName: store.branchCoaches[0]?.name || 'Тренер',
    pool: 'Основной бассейн'
  })

  const [formData, setFormData] = useState({ 
    childName: '', 
    parentName: '', 
    phone: '', 
    email: '', 
    birthDate: '',
    category: '', 
    lessonsPerWeek: '', 
    paidAmount: '', 
    branchId: store.branches.some((b: IBranch) => b.id === store.selectedBranchId) ? store.selectedBranchId : ''
  })

  const resetForm = () => {
    setFormData({ 
      childName: '', 
      parentName: '', 
      phone: '', 
      email: '', 
      birthDate: '', 
      category: '', 
      lessonsPerWeek: '', 
      paidAmount: '', 
      branchId: store.branches.some((b: IBranch) => b.id === store.selectedBranchId) ? store.selectedBranchId : ''
    })
  }

  const age = calculateAge(formData.birthDate)

  const updateForm = (field: string, value: any) => {
    const nextData = { ...formData, [field]: value };
    if (field === 'category' || field === 'lessonsPerWeek') {
      const cat = field === 'category' ? value : nextData.category;
      const les = field === 'lessonsPerWeek' ? Number(value) : Number(nextData.lessonsPerWeek);
      if (cat && les && PRICE_LIST[cat]?.[les]) {
        nextData.paidAmount = String(PRICE_LIST[cat][les]);
      }
    }
    setFormData(nextData);
  }

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, birthDate: formatBirthDate(e.target.value) })
  }

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, phone: formatPhone(e.target.value) })
  }

  const handleSubmit = async () => {
    if (!formData.childName.trim() || formData.childName.length < 2) {
      alert("Введите корректное имя ребенка (минимум 2 символа)");
      return;
    }
    if (!formData.parentName.trim() || formData.parentName.length < 2) {
      alert("Введите корректное имя родителя");
      return;
    }
    
    const digitsOnly = formData.phone.replace(/\D/g, "");
    if (digitsOnly.length < 11) {
      alert("Введите полный номер телефона (11 цифр)");
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (formData.email && formData.email.trim() !== '' && !emailRegex.test(formData.email)) {
      alert("Введите корректный email (или оставьте поле пустым)");
      return;
    }

    const dateRegex = /^\d{2}\.\d{2}\.\d{4}$/;
    if (!dateRegex.test(formData.birthDate)) {
      alert("Введите дату рождения в формате ДД.ММ.ГГГГ");
      return;
    }

    const initials = formData.childName.split(' ').map((x: any) => x[0]).join('').slice(0, 2).toUpperCase()

    const clientData: CreateClientDto = {
      childName: formData.childName,
      parentName: formData.parentName,
      phone: formData.phone,
      email: formData.email,
      birthDate: formData.birthDate,
      age: age,
      branchId: formData.branchId,
      status: 'Активен',
      category: formData.category as any,
      lessonsPerWeek: Number(formData.lessonsPerWeek) as any,
      paidAmount: Number(formData.paidAmount),
      initials,
      subscription: {
        id: Date.now().toString(),
        clientId: 'temp-id', // Будет обновлен сервером
        totalLessons: 8,
        remainingLessons: 8,
        paid: true,
        purchasedAt: new Date().toISOString(),
        receiptUrl: ''
      }
    }
    await store.clientStore.addClient(clientData)
    setIsAddClientOpen(false)
    resetForm()
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Клиенты</h2>
        {store.authStore.isAdmin && (
          <Dialog open={isAddClientOpen} onOpenChange={(open) => { setIsAddClientOpen(open); if (!open) resetForm(); }}>
            <DialogTrigger className="rounded-full bg-cyan-100 hover:bg-cyan-200 text-cyan-800 shadow-sm transition-all px-4 py-2 text-sm inline-flex items-center justify-center font-medium">
              <Plus className="mr-2 size-4" /> Добавить клиента
            </DialogTrigger>
            <DialogContent className="max-w-[450px] p-0 rounded-3xl overflow-hidden border-pink-100 bg-white max-h-[90vh] overflow-y-auto">
              <DialogHeader className="p-6 border-b border-pink-50 bg-gradient-to-br from-cyan-50 via-white to-pink-50/50">
                <DialogTitle className="text-2xl font-extrabold text-cyan-950 tracking-tight">Новый клиент</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 p-6">
                <Input placeholder="Имя ребенка" value={formData.childName} onChange={e => updateForm('childName', e.target.value)} className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-11" />
                <Input placeholder="Имя родителя" value={formData.parentName} onChange={e => updateForm('parentName', e.target.value)} className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-11" />
                <Input placeholder="+7 (000) 000-00-00" value={formData.phone} onChange={handlePhoneChange} className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-11" />
                <Input placeholder="Email" value={formData.email} onChange={e => updateForm('email', e.target.value)} className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-11" />
                <div className="grid grid-cols-2 gap-3">
                  <Input placeholder="ДД.ММ.ГГГГ" value={formData.birthDate} onChange={handleDateChange} maxLength={10} className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-11" />
                  <div className="h-11 flex items-center px-4 bg-slate-50 border border-slate-100 rounded-xl font-semibold text-slate-700 text-sm">
                      {age}
                  </div>
                </div>

                <Select value={formData.category} onValueChange={(val) => updateForm('category', val)}>
                  <SelectTrigger className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-11 px-4 shadow-sm">
                    <SelectValue placeholder="Категория" />
                  </SelectTrigger>
                  <SelectContent className="rounded-xl border-cyan-100 shadow-xl bg-white">
                    <SelectItem value="плавание">Плавание</SelectItem>
                    <SelectItem value="синхронное плавание">Синхронное плавание</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={String(formData.lessonsPerWeek)} onValueChange={(val) => updateForm('lessonsPerWeek', Number(val))}>
                   <SelectTrigger className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-11 px-4 shadow-sm">
                     <SelectValue placeholder="Занятий в неделю" />
                   </SelectTrigger>
                   <SelectContent className="rounded-xl border-cyan-100 shadow-xl bg-white">
                    <SelectItem value="1">1</SelectItem>
                    <SelectItem value="2">2</SelectItem>
                    <SelectItem value="3">3</SelectItem>
                   </SelectContent>
                </Select>

                <Input type="number" placeholder="Сумма оплаты" value={formData.paidAmount} onChange={e => updateForm('paidAmount', e.target.value)} className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-11" />

                <Select 
                  value={store.branches.some((b: IBranch) => b.id === formData.branchId) ? formData.branchId : ''} 
                  onValueChange={(val) => updateForm('branchId', val ?? '')}
                >
                  <SelectTrigger className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-11 px-4 shadow-sm">
                    <SelectValue placeholder="Выберите филиал" />
                  </SelectTrigger>
                  <SelectContent className="rounded-xl border-cyan-100 shadow-xl p-2 bg-white" sideOffset={5}>
                    {store.branches.map((b: IBranch) => (
                      <SelectItem 
                        key={b.id} 
                        value={b.id} 
                        className="rounded-lg hover:bg-cyan-50 focus:bg-cyan-50 py-2"
                      >
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button onClick={handleSubmit} className="w-full rounded-full bg-cyan-500 hover:bg-cyan-600 text-white font-bold h-11 transition-all shadow-lg mt-2">
                  Сохранить клиента
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <Dialog open={!!store.selectedClient} onOpenChange={(open) => !open && store.closeClientModal()}>
        <DialogContent className="max-w-[480px] rounded-3xl border-pink-100 bg-white max-h-[85vh] overflow-y-auto p-6">
          {store.selectedClient && (
            <>
              <DialogHeader className="border-b border-pink-50 pb-4">
                <DialogTitle className="text-xl font-bold text-cyan-950">
                  Карточка клиента: {store.selectedClient.childName}
                </DialogTitle>
                <p className="text-sm text-slate-500 mt-1">Родитель: {store.selectedClient.parentName} · {store.selectedClient.phone}</p>
              </DialogHeader>

              <div className="grid gap-6 py-4 text-slate-700">
                <div className="bg-cyan-50/50 p-4 rounded-2xl border border-cyan-100 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-cyan-900">Абонемент и статус</span>
                    <Badge className={store.selectedClient.isActive ? "bg-emerald-500 text-white font-semibold" : "bg-amber-500 text-white font-semibold"}>
                      {store.selectedClient.status}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-600">Остаток занятий:</span>
                    <span className="font-extrabold text-cyan-950 text-base">
                      {store.selectedClient.remainingLessons} / {store.selectedClient.totalLessons || store.selectedClient.remainingLessons} зан.
                    </span>
                  </div>

                  <div className="pt-2 border-t border-cyan-100 flex flex-col gap-2">
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Быстрое начисление абонемента</span>
                    <div className="flex items-center gap-2">
                      <Button 
                        onClick={async () => {
                          const loadingButton = document.getElementById('add-lessons-btn');
                          if(loadingButton) loadingButton.innerText = 'Начисление...';
                          try {
                            await store.clientStore.addLessons(store.selectedClient!.id, 2);
                          } catch (err) {
                            console.error(err);
                            alert('Ошибка при начислении занятий. Попробуйте снова.');
                          } finally {
                            if(loadingButton) loadingButton.innerText = '+2 занятия';
                          }
                        }}
                        id="add-lessons-btn"
                        size="sm" 
                        className="w-full bg-cyan-500 hover:bg-cyan-600 text-white font-bold rounded-xl"
                      >
                        +2 занятия
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3">
                  <h4 className="text-sm font-semibold text-slate-800 uppercase tracking-wider">Дни и время тренировок в расписании</h4>
                  <p className="text-xs text-slate-500">Выберите слоты, которые посещает ребенок:</p>
                  
                  {store.branchLessons.length === 0 ? (
                    <p className="text-sm text-slate-500 italic">В данном филиале пока нет занятий в расписании</p>
                  ) : (
                    <div className="grid gap-2 max-h-44 overflow-y-auto pr-1">
                      {store.branchLessons.map(lesson => {
                        const isAssigned = store.selectedClient!.isAssignedTo(lesson.id)
                        return (
                          <div 
                            key={lesson.id}
                            className={`p-3 rounded-xl border transition-all flex items-center justify-between ${
                              isAssigned 
                                ? 'border-cyan-400 bg-cyan-50/80 text-cyan-950 font-semibold shadow-sm' 
                                : 'border-slate-100 hover:border-cyan-200 hover:bg-slate-50 text-slate-700'
                            }`}
                          >
                            <div className="flex flex-col cursor-pointer" onClick={() => store.clientStore.toggleClientLesson(String(store.selectedClient!.id), String(lesson.id))}>
                              <span className="text-sm font-bold">{lesson.time} · {lesson.title}</span>
                              <span className="text-xs text-slate-500">{lesson.coachName} ({lesson.pool})</span>
                            </div>
                            
                            {isAssigned && (
                               <Button 
                                variant="ghost" 
                                size="sm"
                                className="h-8 w-8 p-0 rounded-full text-rose-500 hover:text-rose-600 hover:bg-rose-50"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    store.clientStore.toggleClientLesson(String(store.selectedClient!.id), String(lesson.id));
                                }}
                               >
                                 ✕
                               </Button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

              <Dialog open={isScheduleModalOpen} onOpenChange={setIsScheduleModalOpen}>
                <DialogContent className="max-w-[400px] p-6 rounded-3xl bg-white border-cyan-100 shadow-2xl">
                  <DialogHeader className="pb-4 border-b border-cyan-50">
                    <DialogTitle className="text-xl font-bold text-cyan-950">Записать в расписание</DialogTitle>
                    <p className="text-xs text-slate-500 mt-1">Укажите день, время и продолжительность занятия</p>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <label className="text-xs font-bold text-slate-700">День недели</label>
                      <Select 
                        value={scheduleForm.dayOfWeek} 
                        onValueChange={(val) => val && setScheduleForm({...scheduleForm, dayOfWeek: val})}
                      >
                        <SelectTrigger className="rounded-xl border-cyan-100 h-11">
                          <SelectValue placeholder="Выберите день" />
                        </SelectTrigger>
                        <SelectContent className="rounded-xl bg-white shadow-xl">
                          {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => (
                            <SelectItem key={d} value={d}>{d}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-2">
                        <label className="text-xs font-bold text-slate-700">Дата</label>
                        <Input 
                          type="date"
                          value={scheduleForm.date} 
                          onChange={e => {
                            const newDate = e.target.value;
                            let autoDay = scheduleForm.dayOfWeek;
                            if (newDate) {
                              const d = new Date(newDate);
                              if (!isNaN(d.getTime())) {
                                const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
                                autoDay = days[d.getDay()];
                              }
                            }
                            setScheduleForm({...scheduleForm, date: newDate, dayOfWeek: autoDay})
                          }} 
                          className="rounded-xl border-cyan-100 h-11"
                        />
                      </div>
                      <div className="grid gap-2">
                        <label className="text-xs font-bold text-slate-700">Время</label>
                        <Input 
                          value={scheduleForm.time} 
                          onChange={e => setScheduleForm({...scheduleForm, time: e.target.value})} 
                          placeholder="17:00"
                          className="rounded-xl border-cyan-100 h-11"
                        />
                      </div>
                    </div>

                    <div className="grid gap-2">
                      <label className="text-xs font-bold text-slate-700">Название тренировки</label>
                      <Input 
                        value={scheduleForm.title} 
                        onChange={e => setScheduleForm({...scheduleForm, title: e.target.value})} 
                        placeholder="Плавание"
                        className="rounded-xl border-cyan-100 h-11"
                      />
                    </div>

                    <div className="grid gap-2">
                      <label className="text-xs font-bold text-slate-700">Тренер</label>
                      <Input 
                        value={scheduleForm.coachName} 
                        onChange={e => setScheduleForm({...scheduleForm, coachName: e.target.value})} 
                        placeholder="Тренер"
                        className="rounded-xl border-cyan-100 h-11"
                      />
                    </div>

                    <Button 
                      onClick={async () => {
                        const newLessonId = String(Date.now());
                        const newLessonData = {
                          id: newLessonId,
                          branchId: store.selectedBranchId,
                          dayOfWeek: scheduleForm.dayOfWeek,
                          date: scheduleForm.date,
                          time: scheduleForm.time,
                          title: scheduleForm.title,
                          coachName: scheduleForm.coachName,
                          pool: scheduleForm.pool,
                          duration: scheduleForm.duration,
                          maxCapacity: 10,
                          count: '0 / 10'
                        };
                        await store.createLesson(newLessonData as any);
                        await store.clientStore.toggleClientLesson(store.selectedClient!.id, newLessonId);
                        setIsScheduleModalOpen(false);
                      }}
                      className="w-full rounded-xl bg-cyan-500 hover:bg-cyan-600 text-white font-bold h-12 mt-2"
                    >
                      Создать и записать
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>

                <div className="pt-2 border-t border-slate-100 flex gap-2">
                  <Button 
                    onClick={() => setIsScheduleModalOpen(true)}
                    variant="outline"
                    className="w-1/2 rounded-2xl border-cyan-200 text-cyan-800 hover:bg-cyan-50 font-semibold h-11"
                  >
                    + Добавить слот
                  </Button>
                  <Button 
                    onClick={() => store.closeClientModal()}
                    className="w-1/2 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-bold h-11"
                  >
                    Готово
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ребенок</TableHead>
                <TableHead>Дата рождения / Возраст</TableHead>
                <TableHead>Родитель</TableHead>
                <TableHead>Телефон</TableHead>
                <TableHead>Оплата</TableHead>
                <TableHead>Статус</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-4 text-slate-500">Нет клиентов</TableCell>
                </TableRow>
              ) : (
                clients.map((client: IClient) => (
                  <TableRow key={client.id} className="cursor-pointer hover:bg-slate-50" onClick={() => store.selectClient(client as any)}>
                    <TableCell className="font-medium">{client.childName}</TableCell>
                    <TableCell>{client.birthDate} / {client.age}</TableCell>
                    <TableCell>{client.parentName}</TableCell>
                    <TableCell>{client.phone}</TableCell>
                    <TableCell className={client.paidAmount > 0 ? 'text-emerald-600' : 'text-rose-600 font-bold'}>
                      {client.paidAmount > 0 ? `${client.paidAmount} ₽` : 'Нет оплаты'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={client.isActive ? 'default' : 'secondary'}>{client.status}</Badge>
                    </TableCell>
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
