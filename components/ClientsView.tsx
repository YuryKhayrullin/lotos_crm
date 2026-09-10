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
  const [formData, setFormData] = useState({ 
    childName: '', 
    parentName: '', 
    phone: '', 
    email: '', 
    birthDate: '',
    branchId: store.selectedBranchId || ''
  })

  // Синхронизируем branchId при открытии формы или смене выбранного филиала
  const resetForm = () => {
    setFormData({ 
      childName: '', 
      parentName: '', 
      phone: '', 
      email: '', 
      birthDate: '', 
      branchId: store.selectedBranchId || '' 
    })
  }

  const age = calculateAge(formData.birthDate)

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, birthDate: formatBirthDate(e.target.value) })
  }

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, phone: formatPhone(e.target.value) })
  }

  const handleSubmit = async () => {
    // ВАЛИДАЦИЯ ВВОДА ПОЛЬЗОВАТЕЛЯ
    if (!formData.childName.trim() || formData.childName.length < 2) {
      alert("Введите корректное имя ребенка (минимум 2 символа)");
      return;
    }
    if (!formData.parentName.trim() || formData.parentName.length < 2) {
      alert("Введите корректное имя родителя");
      return;
    }
    
    // Валидация телефона (должен содержать 11 цифр)
    const digitsOnly = formData.phone.replace(/\D/g, "");
    if (digitsOnly.length < 11) {
      alert("Введите полный номер телефона (11 цифр)");
      return;
    }

    // Валидация email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (formData.email && !emailRegex.test(formData.email)) {
      alert("Введите корректный email (или оставьте поле пустым)");
      return;
    }

    // Валидация даты рождения (ДД.ММ.ГГГГ)
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
      initials,
    }
    await store.clientStore.addClient(clientData)
    setIsAddClientOpen(false)
    resetForm()
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Клиенты</h2>
        <Dialog open={isAddClientOpen} onOpenChange={(open) => { setIsAddClientOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger className="rounded-full bg-cyan-100 hover:bg-cyan-200 text-cyan-800 shadow-sm transition-all px-4 py-2 text-sm inline-flex items-center justify-center font-medium">
            <Plus className="mr-2 size-4" /> Добавить клиента
          </DialogTrigger>
          <DialogContent className="max-w-[450px] p-0 rounded-3xl overflow-hidden border-pink-100 bg-white">
            <DialogHeader className="p-8 border-b border-pink-50 bg-gradient-to-br from-cyan-50 via-white to-pink-50/50">
              <DialogTitle className="text-2xl font-extrabold text-cyan-950 tracking-tight">Новый клиент</DialogTitle>
            </DialogHeader>
            <div className="grid gap-5 p-8">
              <Input placeholder="Имя ребенка" value={formData.childName} onChange={e => setFormData({...formData, childName: e.target.value})} className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-12" />
              <Input placeholder="Имя родителя" value={formData.parentName} onChange={e => setFormData({...formData, parentName: e.target.value})} className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-12" />
              <Input placeholder="+7 (000) 000-00-00" value={formData.phone} onChange={handlePhoneChange} className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-12" />
              <Input placeholder="Email" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-12" />
              <div className="grid grid-cols-2 gap-4">
                <Input placeholder="ДД.ММ.ГГГГ" value={formData.birthDate} onChange={handleDateChange} maxLength={10} className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-12" />
                <div className="h-12 flex items-center px-4 bg-slate-50 border border-slate-100 rounded-xl font-semibold text-slate-700">
                    {age}
                </div>
              </div>
              <Select 
                value={formData.branchId} 
                onValueChange={(val) => setFormData({...formData, branchId: val ?? ''})}
              >
                <SelectTrigger className="border-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 rounded-xl h-12 px-4 shadow-sm">
                  <SelectValue placeholder="Выберите филиал" />
                </SelectTrigger>
                <SelectContent className="rounded-2xl border-cyan-100 shadow-xl p-2 bg-white" sideOffset={5}>
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
              <Button onClick={handleSubmit} className="w-full rounded-full bg-cyan-500 hover:bg-cyan-600 text-white font-bold h-12 transition-all shadow-lg">
                Сохранить клиента
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Dialog open={!!store.selectedClient} onOpenChange={(open) => !open && store.closeClientModal()}>
        <DialogContent className="max-w-[400px] rounded-3xl border-pink-100 bg-white">
          {store.selectedClient && (
            <>
              <DialogHeader className="border-b border-pink-50 pb-4">
                <DialogTitle className="text-xl font-bold text-cyan-950">Карточка клиента</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 py-4 text-slate-700">
                <p><strong>Ребенок:</strong> {store.selectedClient.childName}</p>
                <p><strong>Родитель:</strong> {store.selectedClient.parentName}</p>
                <p><strong>Телефон:</strong> {store.selectedClient.phone}</p>
                <p><strong>Email:</strong> {store.selectedClient.email}</p>
                <p><strong>Дата рождения:</strong> {store.selectedClient.birthDate}</p>
                <p><strong>Возраст:</strong> {store.selectedClient.age}</p>
                <p><strong>Статус:</strong> <Badge className="bg-cyan-100 text-cyan-800">{store.selectedClient.status}</Badge></p>
                <SubscriptionUpload clientId={store.selectedClient.id} />
                <AdminAddLessons clientId={store.selectedClient.id} />
                <Button onClick={() => store.clientStore.markAttendance(store.selectedClient!.id)} className="w-full">
                  Отметить занятие
                </Button>
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
                <TableHead>Статус</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-4 text-slate-500">Нет клиентов</TableCell>
                </TableRow>
              ) : (
                clients.map((client: IClient) => (
                  <TableRow key={client.id} className="cursor-pointer hover:bg-slate-50" onClick={() => store.selectClient(client)}>
                    <TableCell className="font-medium">{client.childName}</TableCell>
                    <TableCell>{client.birthDate} / {client.age}</TableCell>
                    <TableCell>{client.parentName}</TableCell>
                    <TableCell>{client.phone}</TableCell>
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
