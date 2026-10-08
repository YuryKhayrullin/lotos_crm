'use client'

import { useState } from 'react'
import Link from 'next/link'
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
      setError(e instanceof Error ? e.message : 'Не удалось выполнить вход')
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-sm rounded-3xl border-pink-100 shadow-xl">
        <CardHeader className="p-8 pb-4">
          <CardTitle className="text-2xl font-bold text-cyan-950 text-center">Вход в CRM</CardTitle>
        </CardHeader>
        <CardContent className="p-8 pt-2">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void handleLogin()
            }}
          >
            <Input
              name="username"
              aria-label="Логин"
              autoComplete="username"
              maxLength={100}
              placeholder="Логин"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
            />
            <Input
              name="password"
              aria-label="Пароль"
              autoComplete="current-password"
              maxLength={200}
              type="password"
              placeholder="Пароль"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-xl h-12 border-cyan-100 focus:border-cyan-400"
            />
            {error && (
              <p role="alert" className="text-sm text-rose-500 text-center">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={store.authStore.isLoading}
              className="w-full rounded-full bg-cyan-500 hover:bg-cyan-600 text-white font-bold h-12 transition-all shadow-lg"
            >
              {store.authStore.isLoading ? <Loader2 className="animate-spin" /> : 'Войти'}
            </Button>
            <p className="rounded-xl bg-cyan-50 px-3 py-2 text-center text-xs text-cyan-800">
              Новый тренер?{' '}
              <Link href="/register" prefetch={false} className="font-semibold underline underline-offset-2">
                Зарегистрироваться
              </Link>
              . Доступ к филиалу подтверждает администратор.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  )
})
