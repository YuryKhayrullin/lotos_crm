'use client'

import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { getStore } from '@/store/RootStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2 } from 'lucide-react'

const store = getStore()

export const LoginPage = observer(() => {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const handleLogin = async () => {
    setError('')
    try {
      await store.authStore.login(username, password)
    } catch (e) {
      setError('Неверный логин или пароль')
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-sm rounded-3xl border-pink-100 shadow-xl">
        <CardHeader className="p-8 pb-4">
          <CardTitle className="text-2xl font-bold text-cyan-950 text-center">Вход в CRM</CardTitle>
        </CardHeader>
        <CardContent className="p-8 pt-2 grid gap-4">
          <Input 
            placeholder="Логин" 
            value={username} 
            onChange={e => setUsername(e.target.value)} 
            className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
          />
          <Input 
            type="password" 
            placeholder="Пароль" 
            value={password} 
            onChange={e => setPassword(e.target.value)} 
            className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
          />
          {error && <p className="text-sm text-rose-500 text-center">{error}</p>}
          <Button 
            onClick={handleLogin} 
            disabled={store.authStore.isLoading}
            className="w-full rounded-full bg-cyan-500 hover:bg-cyan-600 text-white font-bold h-12 transition-all shadow-lg"
          >
            {store.authStore.isLoading ? <Loader2 className="animate-spin" /> : 'Войти'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
})
