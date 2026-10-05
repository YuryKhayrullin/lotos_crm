'use client'

import { useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { apiClient, ApiError, createRequestId } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2 } from 'lucide-react'

type RegistrationAttempt = { username: string; password: string; requestId: string }

export function CoachRegistration() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [retryPending, setRetryPending] = useState(false)
  const [error, setError] = useState('')
  const [submittedUsername, setSubmittedUsername] = useState('')
  const submitting = useRef(false)
  // Keep an uncertain attempt only in memory. Never store a password in localStorage.
  const attempt = useRef<RegistrationAttempt | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting.current || submittedUsername) return
    setError('')
    if (!attempt.current) {
      const normalizedUsername = username.trim().toLowerCase()
      if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalizedUsername)) {
        setError('Логин: 3–64 латинских буквы, цифры, точка, дефис или подчёркивание. Начните с буквы или цифры.')
        return
      }
      if (password.length < 8 || password.length > 200) {
        setError('Пароль должен содержать от 8 до 200 символов.')
        return
      }
      if (password !== confirmation) {
        setError('Пароли не совпадают.')
        return
      }
      attempt.current = { username: normalizedUsername, password, requestId: createRequestId() }
    }
    submitting.current = true
    setBusy(true)
    const current = attempt.current
    try {
      await apiClient.register(current.username, current.password, current.requestId)
      setSubmittedUsername(current.username)
      attempt.current = null
      setPassword('')
      setConfirmation('')
      setRetryPending(false)
    } catch (failure) {
      const status = failure instanceof ApiError ? Number(failure.status) : 0
      const uncertain = !status || status >= 500 || status === 408
      if (uncertain) {
        setRetryPending(true)
        setError('Сервис не подтвердил результат. Повторите тот же запрос кнопкой ниже: второй аккаунт не создастся.')
      } else {
        attempt.current = null
        setRetryPending(false)
        setError(failure instanceof Error ? failure.message : 'Не удалось зарегистрироваться. Повторите попытку.')
      }
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-md rounded-3xl border-cyan-100 shadow-lg">
        <CardHeader>
          <CardTitle className="text-center text-2xl text-cyan-950">Регистрация тренера</CardTitle>
        </CardHeader>
        <CardContent>
          {submittedUsername ? (
            <div role="status" className="space-y-3 text-sm text-cyan-950">
              <p>
                Запрос на регистрацию обработан. Ваш логин: <strong>{submittedUsername}</strong>.
              </p>
              <p>Сообщите логин администратору. Он назначит филиал и подтвердит доступ, после чего вы сможете войти.</p>
              <p className="text-slate-600">
                Если этот логин уже использовался, пароль существующего аккаунта не изменился. Если вы не можете войти,
                обратитесь к администратору.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="grid gap-4">
              <p className="text-sm text-slate-600">
                Создайте логин и пароль. Данные клиентов доступны только после подтверждения администратором.
              </p>
              <label className="grid gap-1 text-sm">
                Логин
                <Input
                  name="username"
                  autoComplete="username"
                  value={username}
                  maxLength={64}
                  required
                  disabled={busy || retryPending}
                  onChange={(event) => setUsername(event.target.value)}
                />
                <span className="text-xs text-slate-500">
                  От 3 символов: латинские буквы, цифры, точка, дефис, подчёркивание.
                </span>
              </label>
              <label className="grid gap-1 text-sm">
                Пароль
                <Input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  minLength={8}
                  maxLength={200}
                  required
                  disabled={busy || retryPending}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Повторите пароль
                <Input
                  name="confirmation"
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  minLength={8}
                  maxLength={200}
                  required
                  disabled={busy || retryPending}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
              {error && (
                <p role="alert" className="text-sm text-rose-700">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={busy} className="bg-cyan-600 text-white hover:bg-cyan-700">
                {busy ? (
                  <>
                    <Loader2 className="animate-spin" /> Отправляем…
                  </>
                ) : retryPending ? (
                  'Повторить регистрацию'
                ) : (
                  'Зарегистрироваться'
                )}
              </Button>
            </form>
          )}
          <Link
            href="/"
            prefetch={false}
            className="mt-5 block text-center text-sm text-cyan-800 underline underline-offset-2"
          >
            Вернуться ко входу
          </Link>
        </CardContent>
      </Card>
    </main>
  )
}
