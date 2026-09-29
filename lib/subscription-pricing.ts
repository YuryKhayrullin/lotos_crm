export const PRICE_LIST = {
  'синхронное плавание': { 3: 15000, 2: 12000, 1: 7000 },
  плавание: { 3: 10000, 2: 8000, 1: 5500 },
} as const

const BILLING_WEEKS = 4

export type TrainingCategory = keyof typeof PRICE_LIST

export function packagePrice(category: unknown, lessonsPerWeek: unknown): number {
  const frequency = Number(lessonsPerWeek)
  if (category !== 'плавание' && category !== 'синхронное плавание') return 0
  if (![1, 2, 3].includes(frequency)) return 0
  return PRICE_LIST[category][frequency as 1 | 2 | 3] ?? 0
}

export function packageLessonsFromFrequency(lessonsPerWeek: unknown): number {
  const frequency = Number(lessonsPerWeek)
  if (![1, 2, 3].includes(frequency)) return 0
  return frequency * BILLING_WEEKS
}

export function calculatePaymentLessons(category: unknown, lessonsPerWeek: unknown, amount: unknown) {
  const price = packagePrice(category, lessonsPerWeek)
  const paid = Number(amount)
  if (!price || !Number.isFinite(paid) || paid < 0)
    return { price, packages: 0, lessons: 0, remainder: Math.max(0, paid || 0) }
  const packages = Math.floor(paid / price)
  const packageLessons = packageLessonsFromFrequency(lessonsPerWeek)
  return { price, packages, lessons: packages * packageLessons, remainder: paid - packages * price }
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
