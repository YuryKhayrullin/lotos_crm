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
  const [error, setError] = useState<string | null>(null)

  const handleRegister = async () => {
    setError(null)
    try {
      await store.authStore.register(username, password)
      if (store.authStore.registrationSuccess) {
        alert('Администратор создан. Теперь войдите в CRM под этим логином и паролем.')
        onSwitchToLogin()
        store.authStore.setRegistrationSuccess(false)
      }
    } catch (e: any) {
      setError(e instanceof Error ? e.message : 'Ошибка регистрации')
    }
  }

  return (
    <div className="grid gap-4">
      {error && <p className="text-red-500 text-sm">{error}</p>}
      <Input placeholder="Логин" value={username} onChange={(e) => setUsername(e.target.value)} />
      <Input
        type="password"
        placeholder="Пароль (не менее 8 символов)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <p className="rounded-xl bg-cyan-50 px-3 py-2 text-xs text-cyan-800">
        Регистрация доступна только для создания первого администратора. Тренеров администратор добавляет внутри CRM.
      </p>
      <Button onClick={handleRegister} disabled={store.authStore.isLoading}>
        {store.authStore.isLoading ? 'Создание...' : 'Создать администратора'}
      </Button>
      <Button variant="link" onClick={onSwitchToLogin}>
        Уже есть аккаунт? Войти
      </Button>
    </div>
  )
})
