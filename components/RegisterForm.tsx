'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useStore } from '@/store/StoreProvider'
import { observer } from 'mobx-react-lite'

export const RegisterForm = observer(({ onSwitchToLogin }: { onSwitchToLogin: () => void }) => {
  const store = useStore()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [branchId, setBranchId] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleRegister = async () => {
    setError(null)
    try {
      await store.authStore.register(username, password, branchId)
      if (store.authStore.registrationSuccess) {
        alert('Регистрация успешна. Ожидайте подтверждения администратором')
        onSwitchToLogin()
        store.authStore.setRegistrationSuccess(false)
      }
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <div className="grid gap-4">
      {error && <p className="text-red-500 text-sm">{error}</p>}
      <Input placeholder="Логин" value={username} onChange={e => setUsername(e.target.value)} />
      <Input type="password" placeholder="Пароль" value={password} onChange={e => setPassword(e.target.value)} />
      <Input placeholder="ID филиала" value={branchId} onChange={e => setBranchId(e.target.value)} />
      <Button onClick={handleRegister} disabled={store.authStore.isLoading}>
        {store.authStore.isLoading ? 'Регистрация...' : 'Зарегистрироваться'}
      </Button>
      <Button variant="link" onClick={onSwitchToLogin}>Уже есть аккаунт? Войти</Button>
    </div>
  )
})
