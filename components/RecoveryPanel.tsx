'use client'

export function RecoveryPanel({
  title = 'Не удалось открыть приложение',
  message = 'Попробуйте восстановить экран. Если вы сохраняли отметки, проверьте их после восстановления.',
  onRetry,
}: {
  title?: string
  message?: string
  onRetry: () => void
}) {
  return (
    <section role="alert" className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-900">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-3 text-sm text-slate-600">{message}</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" onClick={onRetry} className="rounded-xl bg-cyan-700 px-4 py-2 text-white">
          Повторить
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-xl border border-slate-300 px-4 py-2"
        >
          Перезагрузить страницу
        </button>
      </div>
    </section>
  )
}
