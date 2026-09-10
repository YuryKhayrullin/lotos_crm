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

  const handleRegister = async () => {
    // Реализуем вызов регистрации через AuthStore (добавим метод позже)
    await store.authStore.register(username, password)
  }

  return (
    <div className="grid gap-4">
      <Input placeholder="Логин" value={username} onChange={e => setUsername(e.target.value)} />
      <Input type="password" placeholder="Пароль" value={password} onChange={e => setPassword(e.target.value)} />
      <Button onClick={handleRegister} disabled={store.authStore.isLoading}>
        {store.authStore.isLoading ? 'Регистрация...' : 'Зарегистрироваться'}
      </Button>
      <Button variant="link" onClick={onSwitchToLogin}>Уже есть аккаунт? Войти</Button>
    </div>
  )
})
