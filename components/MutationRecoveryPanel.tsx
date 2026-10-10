'use client'

import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { apiClient, ApiError } from '../lib/api-client'
import { useStore } from '../store/StoreProvider'

type Inbox = Awaited<ReturnType<typeof apiClient.mutationDrafts>>
const labels: Record<string, string> = {
  createClient: 'Создание клиента',
  createLesson: 'Создание занятия',
  createLessonWithClients: 'Создание занятия с учениками',
  recordPayment: 'Платёж',
  recordAdjustment: 'Корректировка занятий',
  createBranch: 'Создание филиала',
  createCoach: 'Создание тренера',
  updateClient: 'Изменение клиента',
  deleteClient: 'Удаление пустой карточки',
  deleteCoach: 'Архивирование тренера',
  updateLesson: 'Изменение занятия',
  cancelLesson: 'Отмена занятия',
  deleteLesson: 'Удаление пустого занятия',
  assignClientLesson: 'Назначение ученика',
  repairLessonLedger: 'Подтверждённое исправление аудита',
  assignUserBranch: 'Назначение филиала аккаунту',
  deactivateUser: 'Отключение доступа',
  activateUser: 'Активация доступа',
  resetCoachPassword: 'Сброс пароля',
  revokeUserSessions: 'Отзыв сессий',
  linkCoachUser: 'Связывание карточки и аккаунта',
}

export const MutationRecoveryPanel = observer(() => {
  const store = useStore()
  const [inbox, setInbox] = useState<Inbox | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [passwords, setPasswords] = useState<Record<string, string>>({})
  const running = useRef(false)
  const readSequence = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const session = store.authStore.sessionVersion
  // AuthStore clears private API flags when accepting a session. Bootstrap
  // establishes the backend afterwards; subscribe to its observable readiness
  // so an observer child cannot remain memoized with native=false after reload.
  const native = store.hasLoadedData && apiClient.isPostgresBackend()
  useEffect(() => {
    if (!native) return
    const controller = new AbortController()
    const refresh = () => {
      const sequence = ++readSequence.current
      void apiClient
        .mutationDrafts(controller.signal)
        .then((value) => {
          if (
            !controller.signal.aborted &&
            store.authStore.sessionVersion === session &&
            readSequence.current === sequence
          ) {
            setInbox(value)
            setError('')
          }
        })
        .catch((failure) => {
          if (
            !controller.signal.aborted &&
            store.authStore.sessionVersion === session &&
            readSequence.current === sequence
          ) {
            if (failure instanceof ApiError && failure.status === 401) store.authStore.expireSession()
            else setError(failure instanceof Error ? failure.message : 'Не удалось проверить попытки')
          }
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener('crm:mutation-attempt', refresh)
    return () => {
      controller.abort()
      window.removeEventListener('focus', refresh)
      window.removeEventListener('crm:mutation-attempt', refresh)
    }
  }, [native, session, reload, store.authStore])

  async function resolve(requestId: string, mode: 'recover' | 'close') {
    if (running.current) return
    if (
      mode === 'close' &&
      !window.confirm(
        'Закрыть эту попытку? Подтверждённые записи не удалятся. Незавершённый запрос с этим ключом больше не сможет записаться.',
      )
    )
      return
    running.current = true
    setBusy(true)
    setError('')
    try {
      const result = await apiClient.resolveMutationDraft(
        requestId,
        mode,
        mode === 'recover' ? passwords[requestId] || undefined : undefined,
      )
      if (store.authStore.sessionVersion !== session) return
      setMessage(
        result.confirmed
          ? 'Операция подтверждена. Обновите экран, чтобы увидеть актуальные данные.'
          : 'Незавершённая попытка закрыта. Подтверждённые записи не изменены.',
      )
      setReload((value) => value + 1)
      heading.current?.focus()
    } catch (failure) {
      if (store.authStore.sessionVersion === session) {
        if (failure instanceof ApiError && failure.status === 401) store.authStore.expireSession()
        else setError(failure instanceof Error ? failure.message : 'Исход пока неизвестен. Повторите ту же попытку.')
      }
    } finally {
      running.current = false
      if (store.authStore.sessionVersion === session) {
        setBusy(false)
        setPasswords({})
      }
    }
  }
  if (!native || (!error && !message && !inbox?.items.length)) return null
  return (
    <section
      aria-label="Восстановление операций"
      className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-slate-800"
    >
      <h2 ref={heading} tabIndex={-1} className="font-semibold">
        Восстановление операций
      </h2>
      <p className="mt-2">
        Перед новой отправкой проверьте прежнюю попытку. Восстановление использует исходные данные и тот же ключ — без
        второго списания или второй карточки.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-rose-700">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-2">
          {message}
        </p>
      )}
      {inbox?.items.map((item) => (
        <div key={item.requestId} className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-white p-3">
          <span>
            {labels[item.action] || 'Операция'} ·{' '}
            {item.confirmed ? 'запись подтверждена, ответ не принят' : 'нужно проверить исход'}
          </span>
          <code className="max-w-full break-all text-xs text-slate-500">{item.requestId}</code>
          {item.requiresCredential && !item.confirmed && (
            <label className="grid gap-1">
              Исходный пароль этой попытки
              <input
                aria-label={'Исходный пароль ' + item.requestId}
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={200}
                disabled={busy}
                value={passwords[item.requestId] || ''}
                onChange={(event) =>
                  setPasswords((previous) => ({ ...previous, [item.requestId]: event.target.value }))
                }
                className="rounded-lg border p-2"
              />
              <span className="text-xs">
                Пароль не сохранялся. Если исходный пароль неизвестен, закройте незавершённую попытку и начните новую.
              </span>
            </label>
          )}
          <button
            disabled={
              busy ||
              Boolean(item.requiresCredential && !item.confirmed && (passwords[item.requestId] || '').length < 8)
            }
            className="rounded-lg border px-3 py-2 focus-visible:outline-2 focus-visible:outline-cyan-700 disabled:opacity-50"
            onClick={() => void resolve(item.requestId, 'recover')}
          >
            Восстановить
          </button>
          <button
            disabled={busy}
            className="rounded-lg border px-3 py-2 focus-visible:outline-2 focus-visible:outline-cyan-700 disabled:opacity-50"
            onClick={() => void resolve(item.requestId, 'close')}
          >
            Закрыть попытку
          </button>
        </div>
      ))}
      {inbox?.hasMore && (
        <p className="mt-2">Показаны первые 20 попыток. После их обработки будут доступны следующие.</p>
      )}
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          disabled={busy}
          className="rounded-lg border bg-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-cyan-700"
          onClick={() => setReload((value) => value + 1)}
        >
          Проверить попытки
        </button>
        {message && (
          <button
            disabled={busy}
            className="rounded-lg bg-cyan-700 px-3 py-2 text-white focus-visible:outline-2 focus-visible:outline-cyan-900"
            onClick={() => window.location.reload()}
          >
            Обновить экран
          </button>
        )}
      </div>
    </section>
  )
})
