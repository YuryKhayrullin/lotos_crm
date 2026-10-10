const inputMessages = Object.freeze({
  PASSWORD_LENGTH: 'Пароль должен содержать от 12 до 200 символов. Аккаунт не создавался.',
  PASSWORD_MISMATCH: 'Пароль и повтор не совпадают. Аккаунт не создавался.',
  INVALID_USERNAME:
    'Логин: от 3 до 64 символов — латинские буквы, цифры, точка, дефис или подчёркивание; первый символ — буква или цифра. Аккаунт не создавался.',
  INVALID_NAME: 'Имя должно содержать от 1 до 150 символов. Аккаунт не создавался.',
  INVALID_INPUT: 'Проверьте введённые данные. Аккаунт не создавался.',
  CANCELLED: 'Ввод отменён. Аккаунт не создавался.',
  INTERACTIVE_REQUIRED:
    'Запустите bootstrap в интерактивном терминале. Пароль нельзя передавать аргументом или через pipe.',
  SQL_EDITOR_REQUIRED:
    'Локальный Supabase bootstrap отключён после подтверждённых timeout. Используйте npm run cloud:bootstrap:sql. Аккаунт не создавался.',
})

export class BootstrapInputError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(inputMessages, code) ? code : 'INVALID_INPUT'
    super(inputMessages[safe])
    this.name = 'BootstrapInputError'
    this.code = safe
  }
}

// Only paths from the schema, never issue messages/inputs/values.
export function bootstrapValidationError(issues) {
  const fields = new Set(issues.map((issue) => issue.path?.[0]))
  return new BootstrapInputError(
    fields.has('password')
      ? 'PASSWORD_LENGTH'
      : fields.has('username')
        ? 'INVALID_USERNAME'
        : fields.has('name')
          ? 'INVALID_NAME'
          : 'INVALID_INPUT',
  )
}

const bootstrapSteps = new Set([
  'password-hash',
  'transaction-start',
  'transaction-guard',
  'management-lock',
  'admin-check',
  'user-create',
  'credential-create',
  'audit-create',
  'transaction-commit',
])

export function bootstrapFailureMessage(error, { phase, confirmed = false, step, elapsedMs }) {
  if (confirmed)
    return '[BOOTSTRAP_CREATED_CLEANUP] Создание администратора подтверждено, но завершение команды прошло с ошибкой. Не запускайте создание повторно.'
  if (error instanceof BootstrapInputError) {
    const code = Object.hasOwn(inputMessages, error.code) ? error.code : 'INVALID_INPUT'
    return `[BOOTSTRAP_${code}] ${inputMessages[code]}`
  }
  if (error?.name === 'PostgresApiError' && error?.code === 'CONFLICT' && error?.status === 409)
    return '[BOOTSTRAP_ALREADY_EXISTS] Администратор уже существует. Повторное создание запрещено.'
  let code = typeof error?.code === 'string' && /^P\d{4}$/.test(error.code) ? error.code : 'UNKNOWN'
  if (
    error?.name === 'BootstrapTransportError' &&
    [
      'PSQL_UNAVAILABLE',
      'PSQL_TIMEOUT',
      'PSQL_FAILED',
      'PSQL_CLEANUP',
      'LOCK_BUSY',
      'IDENTITY_MISMATCH',
      'COMMIT_UNKNOWN',
    ].includes(error.code)
  )
    code = error.code
  const states = new Set([
    '08001',
    '08006',
    '08P01',
    '22021',
    '23502',
    '23503',
    '23505',
    '23514',
    '25006',
    '25P02',
    '25P03',
    '42501',
    '42601',
    '42703',
    '42804',
    '42883',
    '42P01',
    '53100',
    '53200',
    '53300',
    '53400',
    '57014',
    '57P01',
    '57P03',
    'P0001',
  ])
  if (
    error?.name === 'BootstrapTransportError' &&
    typeof error.code === 'string' &&
    states.has(error.code.replace(/^PSQL_SQLSTATE_/, '')) &&
    error.code.startsWith('PSQL_SQLSTATE_')
  )
    code = error.code
  if (phase !== 'creation' && code === 'PSQL_UNAVAILABLE')
    return '[BOOTSTRAP_PSQL_UNAVAILABLE] Нужны работающий Docker в WSL и локальный образ postgres:17-bookworm. Аккаунт не создавался; пароль не запрашивался.'
  if (phase !== 'creation' && code === 'LOCK_BUSY')
    return '[BOOTSTRAP_LOCK_BUSY] Предыдущая операция управления аккаунтами ещё не завершена. Создание не запускалось; не повторяйте запись до проверки транзакций.'
  if (code === 'UNKNOWN') {
    if (
      [
        'Query read timeout',
        'timeout exceeded when trying to connect',
        'Connection terminated due to connection timeout',
      ].includes(error?.message)
    )
      code = 'DB_TIMEOUT'
    else if (['ETIMEDOUT', 'ENETUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code))
      code = 'DB_NETWORK'
    else if (
      ['ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(
        error?.code,
      )
    )
      code = 'DB_TLS'
  }
  if (phase === 'creation') {
    step = bootstrapSteps.has(step) ? step : error?.name === 'BootstrapTransportError' ? error.step : undefined
    const detail = bootstrapSteps.has(step)
      ? ` Шаг: ${step}.${Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 86_400_000 ? ` Время: ${elapsedMs} мс.` : ''}`
      : ''
    return `[BOOTSTRAP_${code}] Создание администратора не подтверждено.${detail} До повторного запуска нужно проверить наличие администратора. Пароли и SQL не выводятся.`
  }
  return `[BOOTSTRAP_${code}] Не удалось выполнить предварительную проверку или настройку bootstrap. Создание аккаунта ещё не запускалось. Пароли и SQL не выводятся.`
}
