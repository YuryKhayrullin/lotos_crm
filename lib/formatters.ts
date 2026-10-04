export const cleanTime = (timeStr?: string | null): string => {
  if (!timeStr) return '--:--'
  if (/^\d{2}:\d{2}$/.test(timeStr)) return timeStr

  try {
    const date = new Date(timeStr)
    if (isNaN(date.getTime())) return '--:--'
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return '--:--'
  }
}

export const formatPhone = (value: string): string => {
  const digits = value.replace(/\D/g, '')
  if (!digits) return ''

  const national = (/^[78]/.test(digits) ? digits.slice(1) : digits).slice(0, 10)
  if (!national) return '+7 ('
  if (national.length < 3) return `+7 (${national}`
  if (national.length === 3) return `+7 (${national})`
  if (national.length < 6) return `+7 (${national.slice(0, 3)}) ${national.slice(3)}`
  if (national.length === 6) return `+7 (${national.slice(0, 3)}) ${national.slice(3, 6)}`
  if (national.length < 8) return `+7 (${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`
  return `+7 (${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6, 8)}-${national.slice(8)}`
}

export const formatBirthDate = (value: string) => {
  return value
    .replace(/\D/g, '')
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/\.(\d{2})(\d)/, '.$1.$2')
    .slice(0, 10)
}

export const calculateAge = (birthDate: string) => {
  const [day, month, year] = birthDate.split('.').map(Number)
  if (!day || !month || !year) return '0 лет'
  const today = new Date()
  let age = today.getFullYear() - year
  const m = today.getMonth() + 1 - month
  if (m < 0 || (m === 0 && today.getDate() < day)) age--
  return `${Math.max(age, 0)} лет`
}
