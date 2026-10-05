'use client'

// Deliberately independent of providers, stores, fonts and UI libraries: this
// screen must still work if the root layout itself cannot render.
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="ru">
      <body>
        <main style={{ maxWidth: 560, margin: '64px auto', padding: 24, fontFamily: 'sans-serif' }}>
          <h1>Не удалось открыть приложение</h1>
          <p>Восстановите экран. Если вы сохраняли отметки, проверьте их после восстановления.</p>
          <button type="button" onClick={retry}>
            Повторить
          </button>{' '}
          <button type="button" onClick={() => window.location.reload()}>
            Перезагрузить страницу
          </button>
        </main>
      </body>
    </html>
  )
}
