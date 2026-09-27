const BILLING_WEEKS = 4

/**
 * Возвращает плановое количество занятий на четыре недели.
 * Сумма оплаты не участвует в расчёте: её администратор вводит отдельно
 * как справочную финансовую информацию.
 */
export function packageLessonsFromFrequency(lessonsPerWeek: unknown): number {
  const frequency = Number(lessonsPerWeek)
  if (![1, 2, 3].includes(frequency)) return 0
  return frequency * BILLING_WEEKS
}

export function countAttendedLessons(history: unknown): number {
  if (!history) return 0

  try {
    const entries = Array.isArray(history) ? history : JSON.parse(String(history))
    if (!Array.isArray(entries)) return 0
    return entries.filter((entry) => entry?.status === 'attended' && entry?.isWalkin !== true).length
  } catch {
    return 0
  }
}
