export const cleanTime = (timeStr?: string | null): string => {
  if (!timeStr) return '--:--';
  if (/^\d{2}:\d{2}$/.test(timeStr)) return timeStr;
  
  try {
    const date = new Date(timeStr);
    if (isNaN(date.getTime())) return '--:--';
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
};

export const formatPhone = (value: string) => {
  const phone = value.replace(/\D/g, '').slice(0, 11)
  if (!phone) return ''
  if (phone.length === 1) return `+7 (${phone.replace('7', '')}`
  if (phone.length < 5) return `+7 (${phone.slice(1)}`
  if (phone.length < 8) return `+7 (${phone.slice(1, 4)}) ${phone.slice(4)}`
  if (phone.length < 10) return `+7 (${phone.slice(1, 4)}) ${phone.slice(4, 7)}-${phone.slice(7)}`
  return `+7 (${phone.slice(1, 4)}) ${phone.slice(4, 7)}-${phone.slice(7, 9)}-${phone.slice(9)}`
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
  return `${age} лет`
}
