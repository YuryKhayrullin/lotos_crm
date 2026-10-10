import { cleanDate, parseTimeToHHMM } from '@/lib/utils/date'

type LessonInfo = { id: string; title: string; time: string | number; coachName: string }

export function ClientAttendanceHistory({
  history,
  lessons,
}: {
  history: readonly unknown[]
  lessons: readonly LessonInfo[]
}) {
  const entries = history
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry &&
        typeof entry === 'object' &&
        ['attended', 'absent'].includes(String((entry as Record<string, unknown>).status)),
    )
    .slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
  const attended = entries.filter((entry) => entry.status === 'attended').length
  return (
    <details className="group rounded-2xl border border-cyan-100 bg-white shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 [&::-webkit-details-marker]:hidden">
        <div>
          <span className="text-sm font-bold text-slate-900">История посещений</span>
          <p className="mt-1 text-xs text-slate-500">
            Пришёл: {attended} · Пропустил: {entries.length - attended}
          </p>
        </div>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-4 w-4 shrink-0 text-cyan-700 transition-transform group-open:rotate-180"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      {entries.length === 0 ? (
        <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
          Посещений пока нет. После сохранения отметки тренером здесь появятся дата и занятие.
        </p>
      ) : (
        <ol
          aria-label="Посещения, последние сверху"
          className="grid max-h-72 gap-2 overflow-y-auto border-t border-slate-100 p-3"
        >
          {entries.map((entry, index) => {
            const context =
              entry.lessonContext && typeof entry.lessonContext === 'object'
                ? (entry.lessonContext as Record<string, unknown>)
                : null
            const lesson = context?.title
              ? {
                  title: String(context.title),
                  time: String(context.time || ''),
                  coachName: String(context.coachName || ''),
                }
              : lessons.find((item) => item.id === String(entry.lessonId))
            const came = entry.status === 'attended'
            const charged = came && entry.isWalkin !== true
            return (
              <li
                key={`${String(entry.lessonId)}:${String(entry.date)}:${index}`}
                className="rounded-lg bg-slate-50/70 px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-900">
                    {cleanDate(String(entry.date || ''))}
                    {lesson ? ` · ${parseTimeToHHMM(lesson.time)}` : ''}
                  </p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${came ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-700'}`}
                  >
                    {came ? 'Пришёл' : 'Не пришёл'}
                  </span>
                </div>
                <p className="mt-1 text-sm font-medium text-slate-800">
                  {lesson?.title || 'Занятие удалено из расписания'}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {lesson?.coachName ? `Тренер: ${lesson.coachName} · ` : ''}
                  {entry.recordedBy ? `Отметил: ${String(entry.recordedBy)}` : 'Автор отметки не указан'}
                </p>
                <p className="mt-1 text-xs font-medium text-slate-600">
                  {charged ? 'Списано 1 занятие' : 'Без списания занятий'}
                </p>
              </li>
            )
          })}
        </ol>
      )}
    </details>
  )
}
