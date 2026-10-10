'use client'

import { useEffect, useRef, useState } from 'react'
import { apiClient, ApiError, type ReceiptAttempt } from '@/lib/api-client'
import { useStore } from '@/store/StoreProvider'
import { Button } from '@/components/ui/button'

export function ClientReceiptPanel({
  clientId,
  receiptUrl,
  receiptVersion,
  onSaved,
}: {
  clientId: string
  receiptUrl: string
  receiptVersion: number
  onSaved: () => void | Promise<void>
}) {
  const store = useStore(),
    running = useRef(false),
    [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [message, setMessage] = useState(''),
    [attempts, setAttempts] = useState<ReceiptAttempt[]>([]),
    [checking, setChecking] = useState(true),
    [readError, setReadError] = useState(''),
    [reload, setReload] = useState(0)
  const version = store.authStore.sessionVersion,
    userId = store.authStore.user?.id,
    enabled = apiClient.isReceiptsEnabled()
  const sameSession = () => store.authStore.sessionVersion === version && store.authStore.user?.id === userId
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    void apiClient
      .receiptAttempts(clientId, controller.signal)
      .then((rows) => {
        if (
          !controller.signal.aborted &&
          store.authStore.sessionVersion === version &&
          store.authStore.user?.id === userId
        )
          setAttempts(rows)
      })
      .catch((error) => {
        if (!controller.signal.aborted && store.authStore.sessionVersion === version) {
          setReadError('Не удалось проверить незавершённые загрузки. Повторите проверку.')
          if (error instanceof ApiError && error.status === 401) store.authStore.expireSession()
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && store.authStore.sessionVersion === version) setChecking(false)
      })
    return () => controller.abort()
  }, [clientId, version, userId, store, reload, enabled])
  async function recover(attempt: ReceiptAttempt, discard = false) {
    if (running.current) return
    if (discard && !window.confirm('Закрыть эту попытку? Подтверждённая квитанция и файлы не будут удалены.')) return
    running.current = true
    setBusy(true)
    setMessage('')
    try {
      if (discard || attempt.resumable)
        await apiClient.receiptRecoveryPost(clientId, {
          requestId: attempt.requestId,
          ...(discard ? { discard: true } : {}),
        })
      else {
        if (!file) {
          setMessage('Выберите исходный файл этой попытки.')
          return
        }
        await apiClient.uploadReceipt(clientId, file, receiptVersion, attempt)
      }
      if (!sameSession()) return
      setUnknown(false)
      setFile(null)
      setChecking(true)
      setReadError('')
      setReload((value) => value + 1)
      setMessage(
        discard
          ? 'Попытка закрыта; подтверждённые документы не удалены.'
          : 'Квитанция сохранена. Повторного платежа или начисления нет.',
      )
      try {
        await onSaved()
      } catch {
        setMessage('Операция подтверждена. Не удалось обновить карточку; повторите чтение, не новую загрузку.')
      }
    } catch (error) {
      if (!sameSession()) return
      setMessage(error instanceof Error ? error.message : 'Не удалось восстановить загрузку')
      if (error instanceof ApiError && error.status === 401) store.authStore.expireSession()
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  async function upload() {
    if (!file || running.current) return
    running.current = true
    setBusy(true)
    setMessage('')
    try {
      await apiClient.uploadReceipt(clientId, file, receiptVersion)
      if (!sameSession()) return
      setUnknown(false)
      setFile(null)
      setMessage('Квитанция сохранена. Она не начисляет занятия и не изменяет оплату.')
      try {
        await onSaved()
      } catch {
        setMessage('Квитанция сохранена. Не удалось обновить карточку — обновите данные вручную.')
      }
    } catch (error) {
      if (!sameSession()) return
      const uncertain = !(
        error instanceof ApiError && [400, 401, 403, 404, 409, 413, 415, 422].includes(Number(error.status))
      )
      setUnknown(uncertain)
      setMessage(
        uncertain
          ? 'Загрузка не подтверждена. Повторите тот же файл; новые данные пока не отправляйте.'
          : error instanceof Error
            ? error.message
            : 'Не удалось загрузить квитанцию',
      )
      if (error instanceof ApiError && error.status === 401) store.authStore.expireSession()
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  if (!enabled)
    return (
      <section aria-label="Квитанция клиента" className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-sm text-slate-500">
          Квитанции отключены на тестовом стенде. Оплаты и посещаемость работают без прикрепления файлов.
        </p>
      </section>
    )
  return (
    <section aria-label="Квитанция клиента" className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="font-semibold">Квитанция</h3>
      <p className="text-sm text-slate-500">
        Приватный JPG, PNG или PDF до {apiClient.getReceiptMaxBytes() / (1024 * 1024)} МиБ. Квитанция — только документ,
        не платёж.
      </p>
      {checking && <p role="status">Проверяем незавершённые загрузки…</p>}
      {readError && (
        <div role="alert">
          <p>{readError}</p>
          <Button
            variant="outline"
            onClick={() => {
              setChecking(true)
              setReadError('')
              setReload((value) => value + 1)
            }}
          >
            Повторить проверку загрузок
          </Button>
        </div>
      )}
      {attempts.map((attempt) => (
        <div key={attempt.requestId} className="grid gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p>
            Незавершённая загрузка: {attempt.metadata?.fileName || 'старый файл'}.{' '}
            {attempt.resumable
              ? 'Файл уже сохранён приватно; можно продолжить без повторного выбора.'
              : 'Выберите исходный файл; новые данные не заменяют прежнюю попытку.'}
          </p>
          <Button
            disabled={busy || checking || Boolean(readError) || (!attempt.resumable && (!file || !attempt.metadata))}
            onClick={() => void recover(attempt)}
          >
            Восстановить загрузку
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void recover(attempt, true)}>
            Закрыть попытку без удаления файлов
          </Button>
        </div>
      ))}
      {receiptUrl && (
        <a className="text-sm text-cyan-700 underline" href={'/api/receipts/' + encodeURIComponent(clientId)}>
          Скачать текущую квитанцию
        </a>
      )}
      <label className="grid gap-2 text-sm">
        Файл квитанции
        <input
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          disabled={busy || checking || Boolean(readError) || (unknown && !attempts.length)}
          onChange={(event) => {
            setFile(event.target.files?.[0] || null)
            setMessage('')
          }}
        />
      </label>
      <Button
        disabled={!file || busy || checking || Boolean(readError) || attempts.length > 0}
        onClick={() => void upload()}
      >
        {busy ? 'Проверяем и сохраняем…' : unknown ? 'Повторить загрузку' : 'Загрузить квитанцию'}
      </Button>
      {message && (
        <p role="status" className="text-sm text-slate-600">
          {message}
        </p>
      )}
    </section>
  )
}
