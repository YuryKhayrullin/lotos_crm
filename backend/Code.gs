var ACTIVE_IDEMPOTENCY_KEY = ''
var ACTIVE_IDEMPOTENCY_FINGERPRINT = ''
var ACTIVE_MUTATION_LOCK = false
var AUTH_USER_CACHE_TTL_SECONDS = 60
var API_ERROR_CODES = ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'BUSY', 'SCHEMA']

function diagnosticLog(event, details) {
  try {
    Logger.log('[lotos-gas] ' + event + ' ' + JSON.stringify(details || {}))
  } catch (loggingError) {}
}

function publicApiErrorMessage(code) {
  var messages = {
    UNAUTHORIZED: 'Требуется авторизация',
    FORBIDDEN: 'Недостаточно прав для этого действия',
    VALIDATION: 'Проверьте введённые данные',
    NOT_FOUND: 'Объект не найден',
    CONFLICT: 'Данные изменились или запрос конфликтует с уже выполненной операцией',
    BUSY: 'Система занята. Повторите попытку',
    SCHEMA: 'Сервис данных временно недоступен',
  }
  return messages[code] || messages.SCHEMA
}

function classifyApiError(error) {
  if (error && API_ERROR_CODES.indexOf(String(error.apiCode || '')) !== -1) return String(error.apiCode)
  if (error && error.authStage) return 'UNAUTHORIZED'

  var message = String(error && error.message ? error.message : error || '')
  if (/unauthorized/i.test(message)) return 'UNAUTHORIZED'
  if (
    /схем|schema|script propert|лист (users|клиентов|филиалов|тренеров|расписания|платежей|журнала).*не найден/i.test(
      message,
    )
  )
    return 'SCHEMA'
  if (/система занята|повторите (операцию|настройку|создание|сброс)/i.test(message)) return 'BUSY'
  if (
    /недостаточно прав|доступ.*запрещ|разных филиал|одному филиал|не принадлежит филиалу|не назначен филиал|можно .*только/i.test(
      message,
    )
  )
    return 'FORBIDDEN'
  if (
    /requestId|уже использован|уже существует|уже связан|не совпада|устарел|требует сверки|требует повторной загрузки|противореч|карточка не пустая|клиент в архиве|закончились занятия|не записан/i.test(
      message,
    )
  )
    return 'CONFLICT'
  if (/не найден|не найдено/i.test(message)) return 'NOT_FOUND'
  if (
    /некоррект|недопустим|не указан|укажите|обязательно|поле|слишком|пустой|должн|тариф|файл|сумм|нагруз|категори|корректиров|проходн|подтвердите|действие/i.test(
      message,
    )
  )
    return 'VALIDATION'
  return 'SCHEMA'
}

function apiErrorPayload(errorOrCode) {
  var code =
    typeof errorOrCode === 'string' && API_ERROR_CODES.indexOf(errorOrCode) !== -1
      ? errorOrCode
      : classifyApiError(errorOrCode)
  return { status: 'error', code: code, message: publicApiErrorMessage(code) }
}

function rejectUnauthorized(stage, details) {
  var context = details || {}
  context.stage = stage
  diagnosticLog('auth.rejected', context)
  var error = new Error('Unauthorized')
  error.authStage = stage
  error.apiCode = 'UNAUTHORIZED'
  throw error
}

function createResponse(data) {
  if (ACTIVE_MUTATION_LOCK) {
    var finalizeStartedAt = new Date().getTime()
    SpreadsheetApp.flush()
    invalidateReadCache()
    diagnosticLog('mutation.finalized', { durationMs: new Date().getTime() - finalizeStartedAt })
    if (ACTIVE_IDEMPOTENCY_KEY && data && data.status !== 'error' && data.success !== false) {
      try {
        CacheService.getScriptCache().put(
          ACTIVE_IDEMPOTENCY_KEY,
          JSON.stringify({ fingerprint: ACTIVE_IDEMPOTENCY_FINGERPRINT, response: data }),
          300,
        )
      } catch (cacheError) {}
    }
  }
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON)
}

function options() {
  return createResponse(apiErrorPayload('UNAUTHORIZED'))
}

// GET is intentionally disabled. All data access must pass through the
// authenticated Next.js BFF and the signed GAS request contract.
function doGet() {
  return createResponse(apiErrorPayload('UNAUTHORIZED'))
}

function safeValue(val) {
  if (val === undefined || val === null) return ''
  var str = String(val).trim()
  // Google Sheets treats values beginning with these characters as formulas.
  if (/^[=+\-@]/.test(str) || /^[\t\r\n]/.test(str)) return "'" + str
  return str
}

function sha256(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str)
  var hex = ''
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i]
    if (b < 0) b += 256
    var h = b.toString(16)
    if (h.length === 1) h = '0' + h
    hex += h
  }
  return hex
}

function hmacSha256(str, salt) {
  var bytes = Utilities.computeHmacSha256Signature(str, salt)
  var hex = ''
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i]
    if (b < 0) b += 256
    var h = b.toString(16)
    if (h.length === 1) h = '0' + h
    hex += h
  }
  return hex
}

function secureEqual(left, right) {
  left = String(left || '')
  right = String(right || '')
  if (left.length !== right.length) return false
  var difference = 0
  for (var i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return difference === 0
}

function verifySignedEnvelope(request, scriptSecret) {
  var encoded = String(request.signedEnvelope || '')
  var signature = String(request.signature || '')
  if (
    !encoded ||
    encoded.length > 12000000 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    !/^[0-9a-fA-F]{64}$/.test(signature)
  ) {
    rejectUnauthorized('signature.shape')
  }
  if (!secureEqual(hmacSha256(encoded, scriptSecret), signature)) rejectUnauthorized('signature.hmac')

  var padded = encoded
  while (padded.length % 4) padded += '='
  var envelope
  try {
    var decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString('UTF-8')
    envelope = JSON.parse(decoded)
  } catch (error) {
    rejectUnauthorized('signature.payload')
  }
  if (!envelope || typeof envelope !== 'object') rejectUnauthorized('signature.payload')

  var timestamp = String(envelope.timestamp || '')
  var nonce = String(envelope.nonce || '')
  if (!/^[0-9]{10}$/.test(timestamp) || !/^[0-9a-fA-F-]{20,80}$/.test(nonce)) rejectUnauthorized('signature.payload')
  var now = Math.floor(new Date().getTime() / 1000)
  if (Math.abs(now - Number(timestamp)) > 300) rejectUnauthorized('signature.timestamp')

  var cache = CacheService.getScriptCache()
  var replayKey = 'gas-nonce:' + nonce
  if (cache.get(replayKey)) rejectUnauthorized('signature.replay')
  cache.put(replayKey, '1', 300)
  return envelope
}

function isScryptPasswordHash(value) {
  return /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{20,}\$[A-Za-z0-9_-]{80,}$/.test(String(value || ''))
}

function getHeaders(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
}

function getOrCreateUsersSheet(ss) {
  var sheet = ss.getSheetByName('Users')
  if (!sheet) {
    sheet = ss.insertSheet('Users')
    sheet.appendRow(['id', 'username', 'password', 'role', 'branchId', 'status', 'disabledAt', 'disabledBy'])
  }
  return sheet
}

function ensureUsersAccessColumns(sheet) {
  var headers = getHeaders(sheet)
  ;['status', 'disabledAt', 'disabledBy'].forEach(function (header) {
    if (headers.indexOf(header) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header)
      headers = getHeaders(sheet)
    }
  })
  var data = sheet.getDataRange().getValues()
  var idIdx = headers.indexOf('id')
  var statusIdx = headers.indexOf('status')
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx] || '').trim() && !String(data[i][statusIdx] || '').trim()) {
      sheet.getRange(i + 1, statusIdx + 1).setValue('Активен')
    }
  }
  return headers
}

function requireUsersAccessColumns(sheet) {
  return requireUsersAccessHeaders(getHeaders(sheet))
}

function requireUsersAccessHeaders(headers) {
  ;['id', 'username', 'password', 'role', 'branchId', 'status', 'disabledAt', 'disabledBy'].forEach(function (header) {
    if (headers.indexOf(header) === -1) throw new Error('Схема Users не обновлена. Запустите setupSchema(): ' + header)
  })
  return headers
}

function ensureCoachUserIdColumn(sheet) {
  var headers = getHeaders(sheet)
  ;['userId', 'phone', 'birthDate'].forEach(function (header) {
    if (headers.indexOf(header) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header)
      headers = getHeaders(sheet)
    }
  })
  return headers
}

function requireCoachUserIdColumn(sheet) {
  var headers = getHeaders(sheet)
  ;['userId', 'phone', 'birthDate'].forEach(function (header) {
    if (headers.indexOf(header) === -1)
      throw new Error('Схема тренеров не обновлена. Запустите setupSchema(): ' + header)
  })
  return headers
}

function isUserActive(status) {
  return String(status || '').trim() === 'Активен'
}

function requireExistingSheet(ss, name) {
  var sheet = ss.getSheetByName(name)
  if (!sheet) throw new Error('Schema is not initialized. Run setupSchema(): ' + name)
  return sheet
}

function requireText(body, field, maxLength) {
  var value = body[field]
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error('Поле обязательно: ' + field)
  }
  if (maxLength && String(value).length > maxLength) {
    throw new Error('Слишком длинное поле: ' + field)
  }
}

function requireId(body) {
  requireText(body, 'id', 100)
}

function isMutatingAction(action) {
  return (
    [
      'registerCoach',
      'assignUserBranch',
      'deactivateUser',
      'activateUser',
      'resetCoachPassword',
      'linkCoachUser',
      'createClient',
      'createLesson',
      'createBranch',
      'createCoach',
      'updateClient',
      'updateLesson',
      'deleteClient',
      'deleteCoach',
      'deleteLesson',
      'assignClientLesson',
      'recordAttendance',
      'recordBulkAttendance',
      'recordPayment',
      'recordAdjustment',
      'repairLessonLedger',
      'uploadReceipt',
    ].indexOf(action) !== -1
  )
}

function getScriptCacheSafe() {
  try {
    return CacheService.getScriptCache()
  } catch (error) {
    return null
  }
}

function authUserCacheKey(userId) {
  return 'lotos-auth-user:' + sha256(String(userId)).substring(0, 48)
}

function invalidateAuthUserCache(userId) {
  if (!userId) return
  var cache = getScriptCacheSafe()
  if (!cache) return
  try {
    cache.remove(authUserCacheKey(userId))
  } catch (error) {}
}

function parseCachedAuthUser(value) {
  if (!value) return null
  try {
    var user = JSON.parse(value)
    if (!user || typeof user !== 'object' || !user.id || !user.username || !user.role) return null
    if (user.role !== 'admin' && user.role !== 'coach') return null
    return {
      id: String(user.id),
      username: String(user.username),
      role: String(user.role),
      branchId:
        user.branchId === null || user.branchId === undefined || String(user.branchId).trim() === ''
          ? null
          : String(user.branchId),
    }
  } catch (error) {
    return null
  }
}

function requireRequestId(body) {
  requireText(body, 'requestId', 150)
}

function requireNonNegativeNumber(body, field) {
  if (body[field] === undefined || body[field] === null || String(body[field]).trim() === '') return
  var value = Number(body[field])
  if (!isFinite(value) || value < 0) throw new Error('Некорректное числовое поле: ' + field)
}

var LEDGER_OWNED_CLIENT_FIELDS = [
  'paidAmount',
  'totalLessons',
  'remainingLessons',
  'paid',
  'purchasedAt',
  'receiptUrl',
  'attendanceHistory',
  'paymentBalance',
]
function rejectLedgerOwnedClientFields(body) {
  LEDGER_OWNED_CLIENT_FIELDS.forEach(function (field) {
    if (body[field] !== undefined) throw new Error('Поле ' + field + ' изменяется только через журнал операций')
  })
}

function isValidIsoDate(value) {
  var match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return false
  var year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3])
  var date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function isValidTime(value) {
  var match = String(value || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return false
  return Number(match[1]) >= 0 && Number(match[1]) <= 23 && Number(match[2]) >= 0 && Number(match[2]) <= 59
}

function isValidBirthDate(value) {
  var match = String(value || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (!match) return false
  var day = Number(match[1]),
    month = Number(match[2]),
    year = Number(match[3])
  var date = new Date(Date.UTC(year, month - 1, day))
  return (
    year >= 1900 &&
    year <= new Date().getUTCFullYear() &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function validateRequest(body) {
  if (!body || !body.action || typeof body.action !== 'string') {
    throw new Error('Не указано действие')
  }
  if (body.action === 'getBootstrapData' && body.includeCoaches !== undefined && typeof body.includeCoaches !== 'boolean')
    throw new Error('Некорректный параметр includeCoaches')

  if (body.action === 'registerCoach') {
    requireText(body, 'username', 64)
    requireText(body, 'passwordHash', 600)
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(String(body.username || '').trim().toLowerCase()))
      throw new Error('Некорректный логин')
    if (!isScryptPasswordHash(body.passwordHash)) throw new Error('Некорректный хеш пароля')
  } else if (body.action === 'getAuthUser') {
    requireText(body, 'username', 100)
  } else if (
    body.action === 'getUsers' ||
    body.action === 'getCurrentUser' ||
    body.action === 'getBootstrapData'
  ) {
    // No payload fields.
  } else if (body.action === 'assignUserBranch') {
    requireText(body, 'userId', 100)
    requireText(body, 'branchId', 100)
  } else if (body.action === 'deactivateUser' || body.action === 'activateUser') {
    requireText(body, 'userId', 100)
  } else if (body.action === 'resetCoachPassword') {
    requireText(body, 'userId', 100)
    requireText(body, 'passwordHash', 600)
    if (!isScryptPasswordHash(body.passwordHash)) throw new Error('Некорректный хеш пароля')
  } else if (body.action === 'linkCoachUser') {
    requireText(body, 'coachId', 100)
    requireText(body, 'userId', 100)
  } else if (body.action === 'getSheet') {
    if (['Клиенты', 'Филиалы', 'Тренеры', 'Расписание'].indexOf(body.sheet) === -1) {
      throw new Error('Недопустимый лист')
    }
  } else if (body.action === 'getClients' || body.action === 'getSubscriptionsPage') {
    if (
      body.page !== undefined &&
      (!isFinite(Number(body.page)) || Number(body.page) < 1 || Math.floor(Number(body.page)) !== Number(body.page))
    )
      throw new Error('Некорректная страница')
    if (
      body.pageSize !== undefined &&
      (!isFinite(Number(body.pageSize)) ||
        Number(body.pageSize) < 1 ||
        Number(body.pageSize) > 500 ||
        Math.floor(Number(body.pageSize)) !== Number(body.pageSize))
    )
      throw new Error('Некорректный размер страницы')
    if (body.query !== undefined && String(body.query).length > 100) throw new Error('Слишком длинный поисковый запрос')
    if (
      body.status !== undefined &&
      body.status !== '' &&
      ['Активен', 'Пауза', 'Архив'].indexOf(String(body.status)) === -1
    )
      throw new Error('Некорректный статус клиента')
    if (body.sortBy !== undefined && ['childName', 'paidAmount'].indexOf(String(body.sortBy)) === -1)
      throw new Error('Некорректное поле сортировки')
    if (body.sortDir !== undefined && ['asc', 'desc'].indexOf(String(body.sortDir)) === -1)
      throw new Error('Некорректное направление сортировки')
  } else if (body.action === 'getDashboardSummary') {
    if (
      body.previewLimit !== undefined &&
      (!isFinite(Number(body.previewLimit)) ||
        Number(body.previewLimit) < 1 ||
        Number(body.previewLimit) > 10 ||
        Math.floor(Number(body.previewLimit)) !== Number(body.previewLimit))
    )
      throw new Error('Некорректный размер превью')
  } else if (body.action === 'getFinanceSummary') {
    // No payload fields beyond the branch scope supplied by BFF.
  } else if (body.action === 'searchClientOptions') {
    if (body.query !== undefined && String(body.query).length > 100) throw new Error('Слишком длинный поисковый запрос')
    if (
      body.category !== undefined &&
      ['плавание', 'синхронное плавание'].indexOf(String(body.category)) === -1
    )
      throw new Error('Недопустимая категория клиента')
    if (
      body.limit !== undefined &&
      (!isFinite(Number(body.limit)) ||
        Number(body.limit) < 1 ||
        Number(body.limit) > 500 ||
        Math.floor(Number(body.limit)) !== Number(body.limit))
    )
      throw new Error('Некорректный лимит поиска')
  } else if (body.action === 'createClient') {
    requireText(body, 'childName', 150)
    requireText(body, 'parentName', 150)
    requireText(body, 'branchId', 100)
    if (body.lessonsPerWeek !== undefined && [1, 2, 3].indexOf(Number(body.lessonsPerWeek)) === -1)
      throw new Error('Некорректная нагрузка')
    requireNonNegativeNumber(body, 'paidAmount')
    if (body.category && ['плавание', 'синхронное плавание'].indexOf(body.category) === -1) {
      throw new Error('Недопустимая категория клиента')
    }
    if (body.birthDate !== undefined && String(body.birthDate).trim() && !isValidBirthDate(body.birthDate)) {
      throw new Error('Некорректная дата рождения')
    }
  } else if (body.action === 'createLesson') {
    requireText(body, 'branchId', 100)
    requireText(body, 'date', 40)
    requireText(body, 'time', 40)
    requireText(body, 'title', 150)
    if (body.clientId !== undefined && String(body.clientId).trim()) requireText(body, 'clientId', 100)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) || !isValidIsoDate(body.date))
      throw new Error('Дата занятия должна быть в ISO-формате')
    if (!isValidTime(body.time)) throw new Error('Время занятия должно быть в формате HH:mm')
  } else if (body.action === 'createBranch') {
    requireText(body, 'name', 150)
    requireText(body, 'address', 300)
  } else if (body.action === 'createCoach') {
    requireText(body, 'name', 150)
    requireText(body, 'branchId', 100)
    if (body.phone !== undefined && String(body.phone).length > 40) throw new Error('Слишком длинное поле: phone')
    if (body.birthDate !== undefined && String(body.birthDate).trim() && !isValidBirthDate(body.birthDate)) {
      throw new Error('Некорректная дата рождения')
    }
    if (Boolean(body.username) !== Boolean(body.passwordHash))
      throw new Error('Для создания доступа укажите и логин, и пароль')
    if (body.username) {
      requireText(body, 'username', 100)
      requireText(body, 'passwordHash', 600)
      if (!isScryptPasswordHash(body.passwordHash)) throw new Error('Некорректный хеш пароля')
    }
  } else if (body.action === 'assignClientLesson') {
    requireText(body, 'clientId', 100)
    requireText(body, 'lessonId', 100)
  } else if (body.action === 'updateClient') {
    requireId(body)
    rejectLedgerOwnedClientFields(body)
    if (body.lessonsPerWeek !== undefined && [1, 2, 3].indexOf(Number(body.lessonsPerWeek)) === -1)
      throw new Error('Некорректная нагрузка')
    if (body.category !== undefined && ['плавание', 'синхронное плавание'].indexOf(body.category) === -1)
      throw new Error('Недопустимая категория клиента')
    if (body.status !== undefined && ['Активен', 'Пауза', 'Архив'].indexOf(String(body.status)) === -1)
      throw new Error('Некорректный статус клиента')
    if (body.birthDate !== undefined && String(body.birthDate).trim() && !isValidBirthDate(body.birthDate))
      throw new Error('Некорректная дата рождения')
  } else if (body.action.indexOf('update') === 0 || body.action.indexOf('delete') === 0) {
    requireId(body)
  } else if (body.action === 'recordAttendance') {
    requireText(body, 'clientId', 100)
    if (body.isWalkin === true || body.visitorName) throw new Error('Проходные посетители не поддерживаются')
    requireText(body, 'lessonId', 100)
    requireText(body, 'date', 40)
    requireText(body, 'requestId', 150)
    if (['attended', 'absent'].indexOf(body.status) === -1) throw new Error('Недопустимый статус посещения')
  } else if (body.action === 'recordBulkAttendance') {
    if (!Array.isArray(body.attendance) || body.attendance.length === 0) throw new Error('Пустой список посещаемости')
    if (body.attendance.length > 100) throw new Error('Слишком много отметок за один запрос')
    requireText(body, 'requestId', 150)
    body.attendance.forEach(function (item) {
      requireText(item, 'clientId', 100)
      if (item.isWalkin === true || item.visitorName) throw new Error('Проходные посетители не поддерживаются')
      requireText(item, 'lessonId', 100)
      requireText(item, 'date', 40)
      if (['attended', 'absent'].indexOf(item.status) === -1) throw new Error('Недопустимый статус посещения')
    })
  } else if (body.action === 'recordPayment') {
    requireText(body, 'clientId', 100)
    requireNonNegativeNumber(body, 'amount')
    if (Number(body.amount) <= 0) throw new Error('Сумма платежа должна быть больше нуля')
    if (body.category !== undefined && ['плавание', 'синхронное плавание'].indexOf(body.category) === -1)
      throw new Error('Недопустимая категория клиента')
    if (body.lessonsPerWeek !== undefined && [1, 2, 3].indexOf(Number(body.lessonsPerWeek)) === -1)
      throw new Error('Некорректная нагрузка')
  } else if (body.action === 'recordAdjustment') {
    requireText(body, 'clientId', 100)
    requireText(body, 'reason', 500)
    if (
      !isFinite(Number(body.lessonsDelta)) ||
      Number(body.lessonsDelta) === 0 ||
      Math.abs(Number(body.lessonsDelta)) > 100
    ) {
      throw new Error('Корректировка должна быть целым количеством от -100 до 100 занятий')
    }
    if (Math.floor(Number(body.lessonsDelta)) !== Number(body.lessonsDelta))
      throw new Error('Корректировка должна быть целым количеством занятий')
  } else if (body.action === 'auditLessonLedger') {
    if (body.clientId !== undefined) requireText(body, 'clientId', 100)
  } else if (body.action === 'repairLessonLedger') {
    requireText(body, 'clientId', 100)
    requireText(body, 'reason', 500)
    if (body.confirmed !== true) throw new Error('Подтвердите исправление результатов аудита')
    if (!isFinite(Number(body.expectedRemainingLessons)) || !isFinite(Number(body.expectedTotalLessons))) {
      throw new Error('Передайте результаты аудита для подтверждения')
    }
  } else if (body.action === 'getLessonRoster') {
    requireText(body, 'lessonId', 100)
    requireText(body, 'date', 40)
  } else if (body.action === 'getClientHistory') {
    requireText(body, 'clientId', 100)
  } else if (body.action === 'uploadReceipt') {
    requireText(body, 'clientId', 100)
    if (body.lessonsCount !== undefined)
      throw new Error('Квитанция не начисляет занятия; используйте платёж или корректировку')
    if (body.fileBase64 && !body.fileName) throw new Error('Не указано имя файла')
  } else if (body.action === 'getReceipt') {
    requireText(body, 'clientId', 100)
  }

  if (isMutatingAction(body.action)) {
    requireRequestId(body)
  }
}

function isKnownAction(action) {
  return (
    [
      'registerCoach',
      'getAuthUser',
      'getUsers',
      'getCurrentUser',
      'getBootstrapData',
      'assignUserBranch',
      'deactivateUser',
      'activateUser',
      'resetCoachPassword',
      'linkCoachUser',
      'getSheet',
      'getClients',
      'getDashboardSummary',
      'getFinanceSummary',
      'getSubscriptionsPage',
      'searchClientOptions',
      'assignClientLesson',
      'createClient',
      'createLesson',
      'createBranch',
      'createCoach',
      'updateClient',
      'updateLesson',
      'deleteClient',
      'deleteCoach',
      'deleteLesson',
      'recordAttendance',
      'recordBulkAttendance',
      'recordPayment',
      'recordAdjustment',
      'auditLessonLedger',
      'repairLessonLedger',
      'uploadReceipt',
      'getReceipt',
      'getClientHistory',
      'getLessonRoster',
    ].indexOf(action) !== -1
  )
}

function nextId() {
  return String(new Date().getTime()) + '-' + String(Math.floor(Math.random() * 100000))
}

var SCHEMA_VERSION = '12'

function setupSchema() {
  // Run once from the Apps Script editor after deploying a new schema.
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(20000)) throw new Error('Система занята, повторите настройку схемы')
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet()
    ensureUsersAccessColumns(getOrCreateUsersSheet(ss))
    var coaches = ss.getSheetByName('Тренеры')
    if (coaches) ensureCoachUserIdColumn(coaches)
    var clients = ss.getSheetByName('Клиенты')
    if (clients) {
      ensureClientSubscriptionColumns(clients)
      configureAccountingColumnProtections(clients)
    }
    var lessons = ss.getSheetByName('Расписание')
    if (lessons) ensureLessonScheduleColumns(lessons)
    getOrCreateAttendanceSheet(ss)
    ensurePaymentsFingerprintColumn(getOrCreatePaymentsSheet(ss))
    ensureLessonLedgerColumns(getOrCreateLessonLedgerSheet(ss))
    ensureAdminAuditColumns(getOrCreateAdminAuditSheet(ss))
    // Mark the schema ready only after every migration step succeeds.
    SpreadsheetApp.flush()
    PropertiesService.getScriptProperties().setProperty('SCHEMA_VERSION', SCHEMA_VERSION)
    return 'Schema ' + SCHEMA_VERSION + ' is ready'
  } finally {
    try {
      SpreadsheetApp.flush()
    } finally {
      lock.releaseLock()
    }
  }
}

// Run once manually from the Apps Script editor to bootstrap the first admin.
// Before running, set BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD_HASH
// in Script Properties. They are deleted immediately after a successful run.
function setupInitialAdmin() {
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(20000)) throw new Error('Система занята, повторите создание администратора')
  try {
    var properties = PropertiesService.getScriptProperties()
    var username = String(properties.getProperty('BOOTSTRAP_ADMIN_USERNAME') || '').trim()
    var passwordHash = String(properties.getProperty('BOOTSTRAP_ADMIN_PASSWORD_HASH') || '')
    if (!username || username.length > 100) throw new Error('Некорректный логин')
    if (!isScryptPasswordHash(passwordHash))
      throw new Error('Укажите корректный BOOTSTRAP_ADMIN_PASSWORD_HASH в формате scrypt$...')

    var sheet = getOrCreateUsersSheet(SpreadsheetApp.getActiveSpreadsheet())
    var headers = ensureUsersAccessColumns(sheet)
    var data = sheet.getDataRange().getValues()
    var usernameIdx = headers.indexOf('username')
    var roleIdx = headers.indexOf('role')
    if (
      data.slice(1).some(function (row) {
        return normalizeRole(row[roleIdx]) === 'admin'
      })
    ) {
      throw new Error(
        'Первый администратор уже создан. Создавать дополнительные аккаунты можно только через раздел «Тренеры».',
      )
    }
    if (
      data.slice(1).some(function (row) {
        return (
          String(row[usernameIdx] || '')
            .trim()
            .toLowerCase() === username.toLowerCase()
        )
      })
    ) {
      throw new Error('Пользователь с таким логином уже существует')
    }
    var row = headers.map(function (header) {
      if (header === 'id') return nextId()
      if (header === 'username') return safeValue(username)
      if (header === 'password') return passwordHash
      if (header === 'role') return '1'
      if (header === 'branchId') return ''
      if (header === 'status') return 'Активен'
      if (header === 'disabledAt' || header === 'disabledBy') return ''
      return ''
    })
    sheet.appendRow(row)
    SpreadsheetApp.flush()
    properties.setProperty('BOOTSTRAP_ADMIN_CREATED', 'true')
    properties.deleteProperty('BOOTSTRAP_ADMIN_USERNAME')
    properties.deleteProperty('BOOTSTRAP_ADMIN_PASSWORD_HASH')
    return 'Администратор создан: ' + username
  } finally {
    try {
      SpreadsheetApp.flush()
    } finally {
      lock.releaseLock()
    }
  }
}

// Use only from the Apps Script editor to migrate an existing administrator
// from a legacy password hash. Set BOOTSTRAP_ADMIN_USERNAME and
// BOOTSTRAP_ADMIN_PASSWORD_HASH first; both values are removed on success.
function resetBootstrapAdminPassword() {
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(20000)) throw new Error('Система занята, повторите сброс пароля')
  try {
    var properties = PropertiesService.getScriptProperties()
    var username = String(properties.getProperty('BOOTSTRAP_ADMIN_USERNAME') || '').trim()
    var passwordHash = String(properties.getProperty('BOOTSTRAP_ADMIN_PASSWORD_HASH') || '')
    if (!username || username.length > 100) throw new Error('Некорректный логин')
    if (!isScryptPasswordHash(passwordHash))
      throw new Error('Укажите корректный BOOTSTRAP_ADMIN_PASSWORD_HASH в формате scrypt$...')

    var sheet = requireExistingSheet(SpreadsheetApp.getActiveSpreadsheet(), 'Users')
    var headers = requireUsersAccessColumns(sheet)
    var data = sheet.getDataRange().getValues()
    var usernameIdx = headers.indexOf('username')
    var roleIdx = headers.indexOf('role')
    var passwordIdx = headers.indexOf('password')
    var rowIndex = -1
    for (var i = 1; i < data.length; i++) {
      if (
        String(data[i][usernameIdx] || '')
          .trim()
          .toLowerCase() === username.toLowerCase() &&
        normalizeRole(data[i][roleIdx]) === 'admin'
      ) {
        rowIndex = i
        break
      }
    }
    if (rowIndex === -1) throw new Error('Администратор с таким логином не найден')
    sheet.getRange(rowIndex + 1, passwordIdx + 1).setValue(passwordHash)
    invalidateAuthUserCache(String(data[rowIndex][headers.indexOf('id')] || '').trim())
    SpreadsheetApp.flush()
    properties.deleteProperty('BOOTSTRAP_ADMIN_USERNAME')
    properties.deleteProperty('BOOTSTRAP_ADMIN_PASSWORD_HASH')
    return 'Пароль администратора сброшен: ' + username
  } finally {
    try {
      SpreadsheetApp.flush()
    } finally {
      lock.releaseLock()
    }
  }
}

function getOrCreateAttendanceSheet(ss) {
  var sheet = ss.getSheetByName('Посещения')
  if (!sheet) {
    sheet = ss.insertSheet('Посещения')
    sheet.appendRow([
      'id',
      'requestId',
      'lessonId',
      'date',
      'clientId',
      'visitorName',
      'status',
      'isWalkin',
      'branchId',
      'recordedBy',
      'createdAt',
    ])
  }
  return sheet
}

function getOrCreatePaymentsSheet(ss) {
  var sheet = ss.getSheetByName('Платежи')
  if (!sheet) {
    sheet = ss.insertSheet('Платежи')
    sheet.appendRow([
      'id',
      'requestId',
      'clientId',
      'branchId',
      'amount',
      'category',
      'lessonsPerWeek',
      'packagePrice',
      'packageLessons',
      'packagesCount',
      'lessonsAdded',
      'paidAt',
      'recordedBy',
      'comment',
      'requestFingerprint',
    ])
  }
  return sheet
}

function ensureLessonScheduleColumns(sheet) {
  var headers = getHeaders(sheet)
  ;['date', 'dayOfWeek', 'time', 'category', 'isRecurring'].forEach(function (header) {
    if (headers.indexOf(header) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header)
      headers = getHeaders(sheet)
    }
  })
  // Sheets must not convert 2026-10-02 or 17:00 into Date objects.
  ;['date', 'time'].forEach(function (header) {
    sheet.getRange(1, headers.indexOf(header) + 1, sheet.getMaxRows(), 1).setNumberFormat('@')
  })
}

function requireLessonScheduleColumns(sheet) {
  var headers = getHeaders(sheet)
  ;['date', 'dayOfWeek', 'time', 'category', 'isRecurring'].forEach(function (header) {
    if (headers.indexOf(header) === -1)
      throw new Error('Схема расписания не обновлена. Запустите setupSchema(): ' + header)
  })
  return headers
}

function ensurePaymentsFingerprintColumn(sheet) {
  if (getHeaders(sheet).indexOf('requestFingerprint') === -1) {
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue('requestFingerprint')
  }
}

var LESSON_LEDGER_HEADERS = [
  'id',
  'requestId',
  'clientId',
  'branchId',
  'paymentId',
  'type',
  'lessonsDelta',
  'totalLessonsDelta',
  'balanceBefore',
  'balanceAfter',
  'totalLessonsBefore',
  'totalLessonsAfter',
  'createdAt',
  'recordedBy',
  'comment',
  'reason',
  'requestFingerprint',
]

function getOrCreateLessonLedgerSheet(ss) {
  var sheet = ss.getSheetByName('Журнал занятий')
  if (!sheet) {
    sheet = ss.insertSheet('Журнал занятий')
    sheet.appendRow(LESSON_LEDGER_HEADERS)
  }
  return sheet
}

function ensureLessonLedgerColumns(sheet) {
  var headers = getHeaders(sheet)
  LESSON_LEDGER_HEADERS.forEach(function (header) {
    if (headers.indexOf(header) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header)
      headers = getHeaders(sheet)
    }
  })
  return headers
}

function requireLessonLedgerColumns(sheet) {
  return requireLessonLedgerHeaders(getHeaders(sheet))
}

function requireLessonLedgerHeaders(headers) {
  LESSON_LEDGER_HEADERS.forEach(function (header) {
    if (headers.indexOf(header) === -1)
      throw new Error('Схема журнала занятий не обновлена. Запустите setupSchema(): ' + header)
  })
  return headers
}

function lessonLedgerRow(headers, entry) {
  return headers.map(function (header) {
    if (header === 'id') return nextId()
    if (header === 'requestId') return safeValue(entry.requestId)
    if (header === 'clientId') return safeValue(entry.clientId)
    if (header === 'branchId') return safeValue(entry.branchId)
    if (header === 'paymentId') return safeValue(entry.paymentId || '')
    if (header === 'type') return safeValue(entry.type)
    if (header === 'lessonsDelta') return Number(entry.lessonsDelta || 0)
    if (header === 'totalLessonsDelta') return Number(entry.totalLessonsDelta || 0)
    if (header === 'balanceBefore') return Number(entry.balanceBefore || 0)
    if (header === 'balanceAfter') return Number(entry.balanceAfter || 0)
    if (header === 'totalLessonsBefore') return Number(entry.totalLessonsBefore || 0)
    if (header === 'totalLessonsAfter') return Number(entry.totalLessonsAfter || 0)
    if (header === 'createdAt') return entry.createdAt || new Date().toISOString()
    if (header === 'recordedBy') return safeValue(entry.recordedBy || '')
    if (header === 'comment') return safeValue(entry.comment || '')
    if (header === 'reason') return safeValue(entry.reason || '')
    if (header === 'requestFingerprint') return safeValue(entry.requestFingerprint || '')
    return ''
  })
}

function appendLessonLedgerEntry(sheet, entry, knownHeaders) {
  var headers = knownHeaders || requireLessonLedgerColumns(sheet)
  var row = lessonLedgerRow(headers, entry)
  var rowIndex = sheet.getLastRow() + 1
  sheet.appendRow(row)
  return { rowIndex: rowIndex, row: row, headers: headers }
}

function appendLessonLedgerEntries(sheet, headers, entries, plannedFirstRow) {
  if (!entries.length) return []
  requireLessonLedgerHeaders(headers)
  var firstRow = plannedFirstRow || sheet.getLastRow() + 1
  var rows = entries.map(function (entry) {
    return lessonLedgerRow(headers, entry)
  })
  sheet.getRange(firstRow, 1, rows.length, headers.length).setValues(rows)
  return rows.map(function (_row, index) {
    return firstRow + index
  })
}

var ADMIN_AUDIT_HEADERS = [
  'id',
  'requestId',
  'action',
  'entityType',
  'entityId',
  'branchId',
  'actorId',
  'recordedBy',
  'changedFields',
  'reason',
  'source',
  'createdAt',
  'requestFingerprint',
]
var ACCOUNTING_PROTECTED_CLIENT_FIELDS = [
  'paidAmount',
  'totalLessons',
  'remainingLessons',
  'paid',
  'purchasedAt',
  'receiptUrl',
  'attendanceHistory',
  'paymentBalance',
]
var ACCOUNTING_PROTECTION_PREFIX = 'Лотос CRM — не редактировать вручную: '

function getOrCreateAdminAuditSheet(ss) {
  var sheet = ss.getSheetByName('Журнал администрирования')
  if (!sheet) {
    sheet = ss.insertSheet('Журнал администрирования')
    sheet.appendRow(ADMIN_AUDIT_HEADERS)
  }
  return sheet
}

function ensureAdminAuditColumns(sheet) {
  var headers = getHeaders(sheet)
  ADMIN_AUDIT_HEADERS.forEach(function (header) {
    if (headers.indexOf(header) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header)
      headers = getHeaders(sheet)
    }
  })
  return headers
}

function appendAdminAudit(ss, entry) {
  // This journal deliberately stores field names, not personal values or a
  // password hash. Accounting amounts and before/after values stay in the
  // dedicated lesson ledger.
  var sheet = getOrCreateAdminAuditSheet(ss)
  var headers = ensureAdminAuditColumns(sheet)
  var requestFingerprint =
    entry.requestFingerprint ||
    sha256(
      JSON.stringify({
        action: String(entry.action || ''),
        requestId: String(entry.requestId || ''),
        entityType: String(entry.entityType || ''),
        entityId: String(entry.entityId || ''),
        actorId: String(entry.actorId || ''),
        changedFields: String(entry.changedFields || ''),
      }),
    )
  var row = headers.map(function (header) {
    if (header === 'id') return nextId()
    if (header === 'requestId') return safeValue(entry.requestId || '')
    if (header === 'action') return safeValue(entry.action || '')
    if (header === 'entityType') return safeValue(entry.entityType || '')
    if (header === 'entityId') return safeValue(entry.entityId || '')
    if (header === 'branchId') return safeValue(entry.branchId || '')
    if (header === 'actorId') return safeValue(entry.actorId || '')
    if (header === 'recordedBy') return safeValue(entry.recordedBy || '')
    if (header === 'changedFields') return safeValue(entry.changedFields || '')
    if (header === 'reason') return safeValue(entry.reason || '')
    if (header === 'source') return safeValue(entry.source || 'BFF')
    if (header === 'createdAt') return entry.createdAt || new Date().toISOString()
    if (header === 'requestFingerprint') return requestFingerprint
    return ''
  })
  var rowIndex = sheet.getLastRow() + 1
  sheet.appendRow(row)
  return { sheet: sheet, rowIndex: rowIndex, row: row }
}

function auditAdminMutation(ss, body, auth, entityType, entityId, branchId, changedFields) {
  if (!auth || auth.role !== 'admin' || !changedFields || !changedFields.length) return null
  return appendAdminAudit(ss, {
    requestId: body.requestId,
    action: body.action,
    entityType: entityType,
    entityId: entityId,
    branchId: branchId || '',
    actorId: auth.id,
    recordedBy: auth.username,
    changedFields: changedFields.join(','),
    reason: String(body.auditReason || body.reason || ''),
    source: 'BFF',
    requestFingerprint: sha256(
      JSON.stringify({
        action: body.action,
        requestId: body.requestId,
        actorId: auth.id,
        entityType: entityType,
        entityId: entityId,
        changedFields: changedFields,
      }),
    ),
  })
}

function valuesDiffer(left, right) {
  if (left instanceof Date && right instanceof Date) return left.getTime() !== right.getTime()
  return (
    String(left === undefined || left === null ? '' : left) !==
    String(right === undefined || right === null ? '' : right)
  )
}

function changedColumnIndexes(beforeRow, afterRow) {
  var indices = []
  for (var index = 0; index < afterRow.length; index++) {
    if (valuesDiffer(beforeRow[index], afterRow[index])) indices.push(index)
  }
  return indices
}

// Writes only contiguous changed cells. The caller keeps the original row so
// a later failed append can roll back precisely the same cells.
function writeChangedRowCells(sheet, sheetRow, beforeRow, afterRow) {
  var indices = changedColumnIndexes(beforeRow, afterRow)
  for (var start = 0; start < indices.length;) {
    var end = start + 1
    while (end < indices.length && indices[end] === indices[end - 1] + 1) end++
    var firstColumn = indices[start]
    var lastColumn = indices[end - 1]
    sheet
      .getRange(sheetRow, firstColumn + 1, 1, lastColumn - firstColumn + 1)
      .setValues([afterRow.slice(firstColumn, lastColumn + 1)])
    start = end
  }
  return indices
}

function configureAccountingColumnProtections(sheet) {
  // A warning-only protection is intentionally non-destructive: existing
  // spreadsheet owners keep their access, but every editor sees the explicit
  // rule. The ledger audit detects any bypassed manual edit before it can be
  // used by payment or attendance operations.
  if (!sheet || !sheet.getProtections || !SpreadsheetApp.ProtectionType || !SpreadsheetApp.ProtectionType.RANGE) return
  var headers = getHeaders(sheet)
  var existing = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE)
  ACCOUNTING_PROTECTED_CLIENT_FIELDS.forEach(function (field) {
    var column = headers.indexOf(field)
    if (column === -1) return
    var description = ACCOUNTING_PROTECTION_PREFIX + field
    var alreadyProtected = existing.some(function (protection) {
      try {
        return protection.getDescription() === description
      } catch (error) {
        return false
      }
    })
    if (alreadyProtected) return
    var protection = sheet.getRange(2, column + 1, Math.max(1, sheet.getMaxRows() - 1), 1).protect()
    protection.setDescription(description)
    protection.setWarningOnly(true)
  })
}

// Simple onEdit runs only for manual spreadsheet edits, never for writes made
// by this script. It does not store cell values; it creates a traceable audit
// record with a synthetic requestId so a bypassed warning is visible.
function onEdit(e) {
  if (!e || !e.range || !e.range.getSheet) return
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(20000)) return
  try {
    var sheet = e.range.getSheet()
    if (!sheet || sheet.getName() !== 'Клиенты') return
    var headers = getHeaders(sheet)
    var firstColumn = e.range.getColumn() - 1
    var width = e.range.getNumColumns ? e.range.getNumColumns() : 1
    var changedFields = []
    for (var index = firstColumn; index < firstColumn + width; index++) {
      if (ACCOUNTING_PROTECTED_CLIENT_FIELDS.indexOf(headers[index]) !== -1) changedFields.push(headers[index])
    }
    if (!changedFields.length) return
    var rangeName = e.range.getA1Notation ? e.range.getA1Notation() : String(e.range.getRow())
    appendAdminAudit(SpreadsheetApp.getActiveSpreadsheet(), {
      requestId: 'manual-sheet:' + String(new Date().getTime()) + ':' + rangeName,
      action: 'manual_sheet_edit_detected',
      entityType: 'Клиенты',
      entityId: 'range:' + rangeName,
      changedFields: changedFields.join(','),
      reason: 'Обнаружена ручная правка защищённой колонки',
      source: 'Google Sheets',
      recordedBy: 'manual-sheet',
    })
    // Manual spreadsheet edits bypass doPost(), so invalidate the same read
    // cache explicitly after the audit record is written under this lock.
    invalidateReadCache()
  } finally {
    lock.releaseLock()
  }
}

function normalizeRole(value) {
  var role = String(value || '')
    .trim()
    .toLowerCase()
  if (role === '1' || role === 'admin') return 'admin'
  if (role === '2' || role === 'coach') return 'coach'
  return ''
}

function requireServerAuth(body) {
  var auth = body && body.auth
  if (!auth || typeof auth !== 'object') rejectUnauthorized('session.missing_auth')

  var claimedId = String(auth.id || '').trim()
  if (!claimedId) rejectUnauthorized('session.invalid_claims', { hasId: false })

  // Reference-data caching must never cache permission to access that data.
  // Read Users once per signed call, including reads and idempotent retries.
  var usersSheet = requireExistingSheet(SpreadsheetApp.getActiveSpreadsheet(), 'Users')
  var usersData = usersSheet.getDataRange().getValues()
  if (!usersData.length) throw new Error('Users schema is invalid')

  var usersHeaders = requireUsersAccessHeaders(usersData[0]).map(function (header) {
    return String(header || '').trim()
  })
  var idIdx = usersHeaders.indexOf('id')
  var usernameIdx = usersHeaders.indexOf('username')
  var roleIdx = usersHeaders.indexOf('role')
  var branchIdx = usersHeaders.indexOf('branchId')
  var statusIdx = usersHeaders.indexOf('status')

  var rowIndex = findRowById(usersData, idIdx, claimedId)
  if (rowIndex === -1) rejectUnauthorized('session.user_not_found')

  var storedId = String(usersData[rowIndex][idIdx] || '').trim()
  var storedUsername = String(usersData[rowIndex][usernameIdx] || '').trim()
  var storedRole = normalizeRole(usersData[rowIndex][roleIdx])
  var storedBranchId = branchIdx === -1 ? null : String(usersData[rowIndex][branchIdx] || '').trim() || null
  if (!isUserActive(usersData[rowIndex][statusIdx])) rejectUnauthorized('session.user_disabled')
  if (!storedId || !storedUsername || !storedRole) {
    rejectUnauthorized('session.user_record_invalid', {
      hasId: Boolean(storedId),
      hasUsername: Boolean(storedUsername),
      hasRole: Boolean(storedRole),
    })
  }

  var claimedUsername = String(auth.username || '').trim()
  var claimedRole = normalizeRole(auth.role)
  var claimedBranchId =
    auth.branchId === undefined || auth.branchId === null ? null : String(auth.branchId).trim() || null
  var claimsChanged =
    claimedUsername !== storedUsername ||
    claimedRole !== storedRole ||
    String(claimedBranchId || '') !== String(storedBranchId || '')
  if (claimsChanged) {
    diagnosticLog('auth.claims_refreshed', {
      roleChanged: claimedRole !== storedRole,
      usernameChanged: claimedUsername !== storedUsername,
      branchChanged: String(claimedBranchId || '') !== String(storedBranchId || ''),
      source: 'users',
    })
  }

  var canonicalUser = {
    id: storedId,
    username: storedUsername,
    role: storedRole,
    branchId: storedBranchId,
  }
  diagnosticLog('auth.accepted', {
    role: storedRole,
    branchAssigned: Boolean(storedBranchId),
    source: 'users.fresh',
  })
  return canonicalUser
}

function isAdminAction(action) {
  return (
    [
      'getUsers',
      'assignUserBranch',
      'deactivateUser',
      'activateUser',
      'resetCoachPassword',
      'linkCoachUser',
      'createBranch',
      'createCoach',
      'deleteCoach',
      'uploadReceipt',
      'getReceipt',
      'getClientHistory',
      'recordPayment',
      'recordAdjustment',
      'auditLessonLedger',
      'repairLessonLedger',
      'createClient',
      'updateClient',
      'deleteClient',
      'assignClientLesson',
      'getFinanceSummary',
      'getSubscriptionsPage',
    ].indexOf(action) !== -1
  )
}

function assertGasPermission(body, auth) {
  var action = body.action
  if (isAdminAction(action) && auth.role !== 'admin') throw new Error('Недостаточно прав')
  if (action === 'getCurrentUser') return
  if (
    auth.role === 'coach' &&
    [
      'getSheet',
      'getBootstrapData',
      'getClients',
      'getDashboardSummary',
      'searchClientOptions',
      'createLesson',
      'updateLesson',
      'deleteLesson',
      'recordAttendance',
      'recordBulkAttendance',
      'getLessonRoster',
    ].indexOf(action) === -1
  ) {
    throw new Error('Недостаточно прав')
  }
  if (auth.role === 'coach' && !auth.branchId) throw new Error('У пользователя не назначен филиал')
}

function branchMatches(auth, branchId) {
  if (!auth || auth.role === 'admin') return true
  return String(branchId || '') === String(auth.branchId || '')
}

function findHeader(headers, name) {
  return headers.indexOf(name)
}

function sheetObjects(sheet) {
  var values = sheet.getDataRange().getValues()
  if (values.length <= 1) return { headers: values.length ? values[0] : [], rows: [] }
  var headers = values[0]
  return { headers: headers, rows: values.slice(1) }
}

function readCacheVersion() {
  return PropertiesService.getScriptProperties().getProperty('READ_CACHE_VERSION') || '1'
}

function invalidateReadCache() {
  PropertiesService.getScriptProperties().setProperty(
    'READ_CACHE_VERSION',
    String(new Date().getTime()) + ':' + nextId(),
  )
}

function objectsForAuth(sheet, auth, requestedBranchId, cacheVersion) {
  var branchKey = auth.role === 'coach' ? String(auth.branchId || '') : String(requestedBranchId || 'all')
  var cacheKey =
    'crm:' + String(cacheVersion || readCacheVersion()) + ':' + sheet.getName() + ':' + auth.role + ':' + branchKey
  var cache = CacheService.getScriptCache()
  try {
    var cached = cache.get(cacheKey)
    if (cached) return JSON.parse(cached)
  } catch (error) {}
  var parsed = sheetObjects(sheet)
  var branchIdx = parsed.headers.indexOf('branchId')
  var branchId = auth.role === 'coach' ? auth.branchId : requestedBranchId || ''
  var idIdx = parsed.headers.indexOf('id')
  var result = parsed.rows
    .filter(function (row) {
      if (sheet.getName() === 'Филиалы' && auth.role === 'coach') {
        return String(row[idIdx] || '') === String(auth.branchId || '')
      }
      if (!branchId || branchIdx === -1) return true
      return String(row[branchIdx] || '') === String(branchId)
    })
    .map(function (row) {
      var obj = {}
      parsed.headers.forEach(function (header, index) {
        if (header) obj[header] = row[index]
      })
      return obj
    })
  try {
    cache.put(cacheKey, JSON.stringify(result), 60)
  } catch (error) {}
  return result
}

function clientSearchMatches(item, query) {
  if (!query) return true
  return [item.childName, item.parentName, item.phone, item.email].some(function (value) {
    return (
      String(value || '')
        .toLowerCase()
        .indexOf(query) !== -1
    )
  })
}

// Before the category field existed, every client belonged to the original
// swimming section. Keep those historical cards visible until setupSchema()
// persists the same explicit value in the sheet.
function normalizedClientCategory(value) {
  var category = String(value || '').trim()
  return category || 'плавание'
}

function filterClientItems(items, body) {
  var query = String(body.query || '')
    .trim()
    .toLowerCase()
  var status = String(body.status || '').trim()
  return items.filter(function (item) {
    if (!clientSearchMatches(item, query)) return false
    if (status && String(item.status || '') !== status) return false
    return true
  })
}

function sortClientItems(items, body) {
  var sortBy = String(body.sortBy || 'childName')
  var sortDir = String(body.sortDir || 'asc') === 'desc' ? -1 : 1
  return items.slice().sort(function (left, right) {
    var leftValue = left[sortBy]
    var rightValue = right[sortBy]
    if (sortBy === 'paidAmount') {
      var numberDifference = Number(leftValue || 0) - Number(rightValue || 0)
      if (numberDifference !== 0) return numberDifference * sortDir
    } else {
      var comparison = String(leftValue || '').localeCompare(String(rightValue || ''))
      if (comparison !== 0) return comparison * sortDir
    }
    return String(left.id || '').localeCompare(String(right.id || ''))
  })
}

function clientPage(items, body) {
  var page = Math.max(1, Number(body.page || 1))
  var pageSize = Math.min(500, Math.max(1, Number(body.pageSize || 100)))
  var start = (page - 1) * pageSize
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page: page,
    pageSize: pageSize,
    hasMore: start + pageSize < items.length,
  }
}

function getScopedClients(ss, auth, body) {
  var sheet = ss.getSheetByName('Клиенты')
  if (!sheet) throw new Error('Лист клиентов не найден')
  return objectsForAuth(sheet, auth, body.branchId)
}

function getClientsPage(ss, auth, body) {
  return clientPage(sortClientItems(filterClientItems(getScopedClients(ss, auth, body), body), body), body)
}

function getSubscriptionsPage(ss, auth, body) {
  return clientPage(sortClientItems(filterClientItems(getScopedClients(ss, auth, body), body), body), body)
}

function getDashboardSummary(ss, auth, body) {
  var items = getScopedClients(ss, auth, body)
  var previewLimit = Math.min(10, Math.max(1, Number(body.previewLimit || 5)))
  var visibleClients = items.filter(function (item) {
    return String(item.status || '') !== 'Архив'
  })
  var preview = sortClientItems(visibleClients, { sortBy: 'childName', sortDir: 'asc' })
    .slice(0, previewLimit)
    .map(function (item) {
      return {
        id: String(item.id || ''),
        childName: String(item.childName || ''),
        parentName: String(item.parentName || ''),
        phone: String(item.phone || ''),
        initials: String(item.initials || ''),
        remainingLessons: Number(item.remainingLessons || 0),
        status: String(item.status || 'Активен'),
      }
    })
  return {
    totalClients: items.length,
    activeClients: items.filter(function (item) {
      return String(item.status || '') === 'Активен'
    }).length,
    pausedClients: items.filter(function (item) {
      return String(item.status || '') === 'Пауза'
    }).length,
    archivedClients: items.filter(function (item) {
      return String(item.status || '') === 'Архив'
    }).length,
    previewTotal: visibleClients.length,
    previewLimit: previewLimit,
    clientsPreview: preview,
  }
}

function getFinanceSummary(ss, auth, body) {
  var items = getScopedClients(ss, auth, body)
  var totalPaidAmount = 0
  var remainingLessons = 0
  var totalLessons = 0
  items.forEach(function (item) {
    totalPaidAmount += Number(item.paidAmount || 0)
    remainingLessons += Number(item.remainingLessons || 0)
    totalLessons += Number(item.totalLessons || 0)
  })
  return {
    totalClients: items.length,
    activeClients: items.filter(function (item) {
      return String(item.status || '') === 'Активен'
    }).length,
    pausedClients: items.filter(function (item) {
      return String(item.status || '') === 'Пауза'
    }).length,
    archivedClients: items.filter(function (item) {
      return String(item.status || '') === 'Архив'
    }).length,
    totalPaidAmount: totalPaidAmount,
    remainingLessons: remainingLessons,
    totalLessons: totalLessons,
  }
}

function searchClientOptions(ss, auth, body) {
  var query = String(body.query || '')
    .trim()
    .toLowerCase()
  var limit = Math.min(500, Math.max(1, Number(body.limit || 20)))
  var category = String(body.category || '').trim()
  var items = getScopedClients(ss, auth, body).filter(function (item) {
    return (
      String(item.status || 'Активен') === 'Активен' &&
      (!category || normalizedClientCategory(item.category) === category) &&
      clientSearchMatches(item, query)
    )
  })
  return {
    items: sortClientItems(items, { sortBy: 'childName', sortDir: 'asc' })
      .slice(0, limit)
      .map(function (item) {
        return {
          id: String(item.id || ''),
          childName: String(item.childName || ''),
          parentName: String(item.parentName || ''),
          branchId: String(item.branchId || ''),
          category: normalizedClientCategory(item.category),
          remainingLessons: Number(item.remainingLessons || 0),
        }
      }),
  }
}

function assertBranchExists(ss, branchId) {
  if (!branchId) throw new Error('Не указан филиал')
  var sheet = ss.getSheetByName('Филиалы')
  if (!sheet) throw new Error('Лист филиалов не найден')
  var parsed = sheetObjects(sheet)
  var idIdx = parsed.headers.indexOf('id')
  var found = parsed.rows.some(function (row) {
    return String(row[idIdx]) === String(branchId)
  })
  if (!found) throw new Error('Филиал не найден')
}

function singleBranchId(ss) {
  var sheet = ss.getSheetByName('Филиалы')
  if (!sheet) throw new Error('Лист филиалов не найден')
  var parsed = sheetObjects(sheet)
  var idIdx = parsed.headers.indexOf('id')
  var ids = parsed.rows
    .map(function (row) {
      return String(row[idIdx] || '').trim()
    })
    .filter(Boolean)
  if (ids.length !== 1) throw new Error('Выберите филиал: найдено филиалов ' + ids.length)
  return ids[0]
}

function resolveBranchId(ss, branchId) {
  var resolved = String(branchId || '').trim() || singleBranchId(ss)
  assertBranchExists(ss, resolved)
  return resolved
}

function assertScopedBranch(body, auth, ss) {
  if (body.branchId) {
    if (!branchMatches(auth, body.branchId)) throw new Error('Доступ к филиалу запрещен')
    assertBranchExists(ss, body.branchId)
  } else if (auth.role === 'coach') {
    body.branchId = auth.branchId
  } else {
    body.branchId = singleBranchId(ss)
  }
}

function revokeReceiptAccess(reference) {
  var value = String(reference || '')
  var fileId = value.indexOf('drive:') === 0 ? value.substring(6) : (value.match(/[-\w]{25,}/) || [])[0]
  if (!fileId) return
  try {
    DriveApp.getFileById(fileId).setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE)
  } catch (error) {}
}

var PRICE_LIST = {
  'синхронное плавание': { 3: 15000, 2: 12000, 1: 7000 },
  плавание: { 3: 10000, 2: 8000, 1: 5500 },
}

function packagePrice(category, lessonsPerWeek) {
  var frequency = Number(lessonsPerWeek)
  if (!PRICE_LIST[String(category || '')] || [1, 2, 3].indexOf(frequency) === -1) return 0
  return PRICE_LIST[String(category)][frequency] || 0
}

function packageLessonsFromFrequency(lessonsPerWeek) {
  var frequency = Number(lessonsPerWeek)
  if ([1, 2, 3].indexOf(frequency) === -1) return 0
  return frequency * 4
}

function paymentCalculation(category, lessonsPerWeek, amount, existingBalance) {
  var price = packagePrice(category, lessonsPerWeek)
  var payment = Number(amount || 0)
  var balance = Number(existingBalance || 0) + payment
  if (!price || !isFinite(balance) || balance < 0) throw new Error('Для выбранной секции нет тарифа')
  var packages = Math.floor(balance / price)
  var packageLessons = packageLessonsFromFrequency(lessonsPerWeek)
  return {
    price: price,
    packageLessons: packageLessons,
    packages: packages,
    lessonsAdded: packages * packageLessons,
    balance: balance - packages * price,
  }
}

function parseHistory(value) {
  try {
    var parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch (error) {
    return []
  }
}

function countAttendedFromHistory(value) {
  return parseHistory(value).filter(function (entry) {
    return entry && entry.status === 'attended' && entry.isWalkin !== true
  }).length
}

function findRowById(data, idIdx, id) {
  for (var i = 1; i < data.length; i++) if (String(data[i][idIdx] || '').trim() === String(id || '').trim()) return i
  return -1
}

function requireLessonOccurrence(lesson, lessonId, occurrenceDate, auth, ss) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(occurrenceDate)) || !isValidIsoDate(occurrenceDate)) {
    throw new Error('Дата занятия должна быть в ISO-формате')
  }
  var idIdx = lesson.headers.indexOf('id')
  var branchIdx = lesson.headers.indexOf('branchId')
  var dateIdx = lesson.headers.indexOf('date')
  var weekdayIdx = lesson.headers.indexOf('dayOfWeek')
  var recurringIdx = lesson.headers.indexOf('isRecurring')
  if ([idIdx, branchIdx, dateIdx, weekdayIdx, recurringIdx].indexOf(-1) !== -1) {
    throw new Error('Схема расписания не обновлена. Запустите setupSchema()')
  }
  var rowIndex = lesson.rows.findIndex(function (row) {
    return String(row[idIdx]) === String(lessonId)
  })
  if (rowIndex === -1) throw new Error('Занятие не найдено')
  var row = lesson.rows[rowIndex]
  var branchId = String(row[branchIdx] || '')
  if (!branchMatches(auth, branchId)) throw new Error('Доступ к филиалу запрещен')
  var scheduledDate = row[dateIdx]
  if (Object.prototype.toString.call(scheduledDate) === '[object Date]') {
    scheduledDate = Utilities.formatDate(scheduledDate, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd')
  }
  scheduledDate = String(scheduledDate || '').trim()
  var recurring = row[recurringIdx] === true || String(row[recurringIdx]).toLowerCase() === 'true'
  if (scheduledDate && (!recurring || scheduledDate === String(occurrenceDate))) {
    if (scheduledDate !== String(occurrenceDate)) throw new Error('Дата не совпадает с датой занятия')
  } else if (recurring) {
    var weekdays = { Вс: 0, Пн: 1, Вт: 2, Ср: 3, Чт: 4, Пт: 5, Сб: 6 }
    var expectedDay = weekdays[String(row[weekdayIdx] || '')]
    var actualDay = new Date(String(occurrenceDate) + 'T00:00:00Z').getUTCDay()
    if (
      expectedDay === undefined ||
      expectedDay !== actualDay ||
      (scheduledDate && String(occurrenceDate) < scheduledDate)
    ) {
      throw new Error('Дата не совпадает с днём повторяющегося занятия')
    }
  } else {
    throw new Error('У занятия не задана дата')
  }
  return { branchId: branchId, row: row }
}

function getLessonRoster(ss, body, auth) {
  var lessonSheet = requireExistingSheet(ss, 'Расписание')
  var lesson = sheetObjects(lessonSheet)
  var occurrence = requireLessonOccurrence(lesson, body.lessonId, body.date, auth, ss)
  var lessonCategoryIdx = lesson.headers.indexOf('category')
  var lessonCategory = lessonCategoryIdx === -1 ? '' : String(occurrence.row[lessonCategoryIdx] || '')

  var clientsContext = sheetContext(ss, 'Клиенты')
  var headers = requireClientSubscriptionHeaders(clientsContext.headers)
  var data = clientsContext.data
  var idIdx = headers.indexOf('id'),
    branchIdx = headers.indexOf('branchId')
  var nameIdx = headers.indexOf('childName'),
    parentNameIdx = headers.indexOf('parentName'),
    categoryIdx = headers.indexOf('category')
  var statusIdx = headers.indexOf('status'),
    remainingIdx = headers.indexOf('remainingLessons')
  var historyIdx = headers.indexOf('attendanceHistory')
  if ([idIdx, branchIdx, nameIdx, categoryIdx, remainingIdx, historyIdx].indexOf(-1) !== -1) {
    throw new Error('Схема клиентов не обновлена. Запустите setupSchema()')
  }
  var clients = data
    .slice(1)
    .filter(function (row) {
      if (String(row[branchIdx] || '') !== occurrence.branchId) return false
      if (lessonCategory && normalizedClientCategory(row[categoryIdx]) !== lessonCategory) return false
      if (statusIdx !== -1 && String(row[statusIdx] || '') === 'Архив') return false
      return true
    })
    .map(function (row) {
      var mark = parseHistory(row[historyIdx]).find(function (entry) {
        return entry && String(entry.lessonId) === String(body.lessonId) && String(entry.date) === String(body.date)
      })
      return {
        id: String(row[idIdx]),
        childName: String(row[nameIdx] || ''),
        parentName: parentNameIdx === -1 ? '' : String(row[parentNameIdx] || ''),
        category: categoryIdx === -1 ? '' : normalizedClientCategory(row[categoryIdx]),
        status: statusIdx === -1 ? '' : String(row[statusIdx] || ''),
        remainingLessons: Number(row[remainingIdx] || 0),
        mark: mark && (mark.status === 'attended' || mark.status === 'absent') ? mark.status : null,
      }
    })
  clients.sort(function (left, right) {
    return left.childName.localeCompare(right.childName, 'ru')
  })
  return { lessonId: String(body.lessonId), date: String(body.date), clients: clients }
}

function validateAttendanceItem(item, ss, auth, sharedClients, sharedLessons) {
  if (!item || !item.lessonId || !item.date || !item.status) throw new Error('Некорректная отметка посещения')
  if (!isValidIsoDate(item.date)) throw new Error('Дата должна быть в ISO-формате')
  if (['attended', 'absent'].indexOf(item.status) === -1) throw new Error('Недопустимый статус посещения')
  if (!item.requestId) throw new Error('Не указан idempotency key')
  var lesson = sharedLessons || sheetObjects(requireExistingSheet(ss, 'Расписание'))
  var occurrenceKey = JSON.stringify([String(item.lessonId), String(item.date)])
  var occurrence = lesson.occurrences && lesson.occurrences[occurrenceKey]
  if (!occurrence) {
    occurrence = requireLessonOccurrence(lesson, item.lessonId, item.date, auth, ss)
    if (lesson.occurrences) lesson.occurrences[occurrenceKey] = occurrence
  }
  var lessonBranch = occurrence.branchId
  if (!item.clientId) throw new Error('Не указан клиент')
  if (item.isWalkin === true || item.visitorName) throw new Error('Проходные посетители не поддерживаются')
  var clientSheet = sharedClients ? sharedClients.sheet : ss.getSheetByName('Клиенты')
  if (!clientSheet) throw new Error('Лист клиентов не найден')
  var headers = sharedClients ? sharedClients.headers : requireClientSubscriptionColumns(clientSheet)
  var data = sharedClients ? sharedClients.data : clientSheet.getDataRange().getValues()
  var idIdx = headers.indexOf('id')
  var clientBranchIdx = headers.indexOf('branchId')
  var clientRow = sharedClients && sharedClients.rowById
    ? sharedClients.rowById[String(item.clientId || '').trim()]
    : findRowById(data, idIdx, item.clientId)
  if (clientRow === undefined) clientRow = -1
  var lessonCategoryIdx = lesson.headers.indexOf('category')
  var clientCategoryIdx = headers.indexOf('category')
  if (clientRow === -1) throw new Error('Клиент не найден')
  if (
    lessonCategoryIdx !== -1 &&
    clientCategoryIdx !== -1 &&
    occurrence.row[lessonCategoryIdx] &&
    normalizedClientCategory(occurrence.row[lessonCategoryIdx]) !==
      normalizedClientCategory(data[clientRow][clientCategoryIdx])
  )
    throw new Error('Категория клиента не совпадает с занятием')
  var clientBranch = clientBranchIdx === -1 ? '' : data[clientRow][clientBranchIdx]
  if (!branchMatches(auth, clientBranch) || String(clientBranch) !== String(lessonBranch))
    throw new Error('Клиент и занятие находятся в разных филиалах')
  var clientStatusIdx = headers.indexOf('status')
  if (clientStatusIdx !== -1 && String(data[clientRow][clientStatusIdx] || '') === 'Архив')
    throw new Error('Клиент в архиве')
  // Balance checks run after duplicate detection in processClientAttendance.
  return {
    lessonBranch: String(lessonBranch),
    clientRowIndex: clientRow,
    clientSheet: clientSheet,
    clientHeaders: headers,
    clientData: data,
  }
}

function processClientAttendance(item, context, auth) {
  var row = context.clientData[context.clientRowIndex],
    headers = context.clientHeaders
  var historyIdx = headers.indexOf('attendanceHistory'),
    remainingIdx = headers.indexOf('remainingLessons')
  var totalIdx = headers.indexOf('totalLessons'),
    statusIdx = headers.indexOf('status'),
    history = parseHistory(row[historyIdx])
  var balanceBefore = Number(row[remainingIdx] || 0),
    totalLessonsBefore = Number(row[totalIdx] || 0)
  var existingIdx = history.findIndex(function (entry) {
    return String(entry.lessonId) === String(item.lessonId) && String(entry.date) === String(item.date)
  })
  var nextCharged = item.status === 'attended' && item.isWalkin !== true
  var balanceDelta = 0
  if (existingIdx !== -1) {
    var existing = history[existingIdx]
    if (String(existing.status) === String(item.status) && Boolean(existing.isWalkin) === Boolean(item.isWalkin))
      return { success: true, duplicate: true }
    var previousCharged = existing.status === 'attended' && existing.isWalkin !== true
    var chargeDelta = (nextCharged ? 1 : 0) - (previousCharged ? 1 : 0)
    if (chargeDelta > 0 && Number(row[remainingIdx] || 0) < chargeDelta)
      throw new Error('У клиента закончились занятия')
    row[remainingIdx] = Math.max(
      0,
      Math.min(Number(row[totalIdx] || Number.MAX_SAFE_INTEGER), Number(row[remainingIdx] || 0) - chargeDelta),
    )
    balanceDelta = -chargeDelta
    existing.status = item.status
    existing.isWalkin = false
    existing.requestId = item.requestId
    existing.recordedBy = auth.username
    history[existingIdx] = existing
  } else {
    if (nextCharged && Number(row[remainingIdx] || 0) <= 0) throw new Error('У клиента закончились занятия')
    history.push({
      date: item.date,
      lessonId: item.lessonId,
      status: item.status,
      isWalkin: false,
      requestId: item.requestId,
      recordedBy: auth.username,
    })
    if (nextCharged) {
      row[remainingIdx] = Math.max(0, Number(row[remainingIdx] || 0) - 1)
      balanceDelta = -1
    }
  }
  row[historyIdx] = JSON.stringify(history)
  if (statusIdx !== -1) row[statusIdx] = Number(row[remainingIdx] || 0) <= 0 ? 'Пауза' : 'Активен'
  var result = { success: true, corrected: existingIdx !== -1 }
  if (balanceDelta !== 0) {
    var branchIdx = headers.indexOf('branchId')
    result.ledgerEntry = {
      requestId: item.requestId,
      clientId: item.clientId,
      branchId: branchIdx === -1 ? '' : String(row[branchIdx] || ''),
      type: existingIdx === -1 ? 'attendance' : 'attendance_correction',
      lessonsDelta: balanceDelta,
      totalLessonsDelta: 0,
      balanceBefore: balanceBefore,
      balanceAfter: Number(row[remainingIdx] || 0),
      totalLessonsBefore: totalLessonsBefore,
      totalLessonsAfter: Number(row[totalIdx] || 0),
      recordedBy: auth.username,
      comment: 'Занятие ' + String(item.lessonId) + ' · ' + String(item.date),
      reason: existingIdx === -1 ? 'Посещение' : 'Исправление посещения',
    }
  }
  return result
}

// Миграция добавляет только отсутствующие колонки абонемента. Финансовые
// значения никогда не выводятся из недельной нагрузки во время миграции.
function ensureClientSubscriptionColumns(sheet) {
  var required = [
    'category',
    'lessonsPerWeek',
    'assignedLessonIds',
    'totalLessons',
    'remainingLessons',
    'paid',
    'purchasedAt',
    'receiptUrl',
    'attendanceHistory',
    'paymentBalance',
  ]
  var headers = getHeaders(sheet)
  required.forEach(function (header) {
    if (headers.indexOf(header) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header)
      headers = getHeaders(sheet)
    }
  })
  var data = sheet.getDataRange().getValues()
  var idIdx = headers.indexOf('id')
  var categoryIdx = headers.indexOf('category')
  var frequencyIdx = headers.indexOf('lessonsPerWeek')
  for (var rowIndex = 1; rowIndex < data.length; rowIndex++) {
    if (!String(data[rowIndex][idIdx] || '').trim()) continue
    if (!String(data[rowIndex][categoryIdx] || '').trim()) {
      sheet.getRange(rowIndex + 1, categoryIdx + 1).setValue('плавание')
    }
    if (!String(data[rowIndex][frequencyIdx] || '').trim()) {
      sheet.getRange(rowIndex + 1, frequencyIdx + 1).setValue(1)
    }
  }
  // Migration intentionally does not infer or rewrite lesson balances from a
  // weekly frequency or a payment amount. Historical differences are exposed
  // by auditLessonLedger and corrected only through a confirmed ledger entry.
  return headers
}

function requireClientSubscriptionColumns(sheet) {
  return requireClientSubscriptionHeaders(getHeaders(sheet))
}

function requireClientSubscriptionHeaders(headers) {
  var required = [
    'assignedLessonIds',
    'totalLessons',
    'remainingLessons',
    'paid',
    'purchasedAt',
    'receiptUrl',
    'attendanceHistory',
    'paymentBalance',
  ]
  required.forEach(function (header) {
    if (headers.indexOf(header) === -1)
      throw new Error('Схема клиентов не обновлена. Запустите setupSchema(): ' + header)
  })
  return headers
}

function attendanceChangedRanges(batch, dirtyRows) {
  var indices = Object.keys(dirtyRows)
    .map(Number)
    .sort(function (left, right) {
      return left - right
    })
  var ranges = []
  if (!indices.length) return ranges

  ;['remainingLessons', 'attendanceHistory', 'status'].forEach(function (header) {
    var column = batch.headers.indexOf(header)
    if (column === -1) throw new Error('Схема клиентов не обновлена. Запустите setupSchema(): ' + header)
    for (var start = 0; start < indices.length;) {
      var end = start + 1
      while (end < indices.length && indices[end] === indices[end - 1] + 1) end++
      var values = indices.slice(start, end).map(function (index) {
        return [batch.data[index][column]]
      })
      ranges.push({ row: indices[start] + 1, column: column + 1, values: values })
      start = end
    }
  })
  return ranges
}

function writeAttendanceChanges(batch, dirtyRows) {
  attendanceChangedRanges(batch, dirtyRows).forEach(function (range) {
    batch.sheet.getRange(range.row, range.column, range.values.length, 1).setValues(range.values)
  })
}

function attendanceApiCell(value) {
  var entered = {}
  if (typeof value === 'number') {
    if (!isFinite(value)) throw new Error('Некорректное число в записи посещения')
    entered.numberValue = value
  } else if (typeof value === 'boolean') entered.boolValue = value
  // stringValue is literal, never interpreted as a spreadsheet formula.
  else entered.stringValue = String(value === null || value === undefined ? '' : value)
  return { userEnteredValue: entered }
}

function writeAttendanceAtomic(ss, batch, dirtyRows, ledgerSheet, ledgerHeaders, entries) {
  // Enable only after adding the Advanced Google Sheets service to this GAS
  // project and testing on a copy. Missing configuration fails BEFORE writes.
  if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets || !Sheets.Spreadsheets.batchUpdate) {
    var unavailable = new Error('Схема атомарной записи не настроена')
    unavailable.apiCode = 'SCHEMA'
    throw unavailable
  }
  var clientSheetId = batch.sheet.getSheetId()
  var requests = attendanceChangedRanges(batch, dirtyRows).map(function (range) {
    return {
      updateCells: {
        range: {
          sheetId: clientSheetId,
          startRowIndex: range.row - 1,
          endRowIndex: range.row - 1 + range.values.length,
          startColumnIndex: range.column - 1,
          endColumnIndex: range.column,
        },
        rows: range.values.map(function (values) { return { values: values.map(attendanceApiCell) } }),
        fields: 'userEnteredValue',
      },
    }
  })
  if (entries.length) {
    requireLessonLedgerHeaders(ledgerHeaders)
    requests.push({
      appendCells: {
        sheetId: ledgerSheet.getSheetId(),
        rows: entries.map(function (entry) {
          return { values: lessonLedgerRow(ledgerHeaders, entry).map(attendanceApiCell) }
        }),
        fields: 'userEnteredValue',
      },
    })
  }
  if (!requests.length) return
  // ONE atomic commit across both sheets. Never fall back or roll back after
  // an API error: a lost acknowledgement may mean the commit already happened.
  // A retry under the same lock recognizes the durable ledger request marker.
  try {
    var spreadsheetId = ss.getId()
    var acknowledgement = Sheets.Spreadsheets.batchUpdate({ requests: requests }, spreadsheetId)
    if (!acknowledgement || String(acknowledgement.spreadsheetId || '') !== String(spreadsheetId)) {
      throw new Error('Запись не подтверждена')
    }
  } catch (error) {
    diagnosticLog('attendance.atomic_commit_unconfirmed', {})
    var unconfirmed = new Error('Сервис данных временно недоступен')
    unconfirmed.apiCode = 'SCHEMA'
    throw unconfirmed
  }
}

function sheetContext(ss, name) {
  var sheet = ss.getSheetByName(name)
  if (!sheet) throw new Error('Лист не найден: ' + name)
  // One complete read is faster than a separate header RPC followed by the
  // same data-range RPC. Every mutation reuses this in-memory snapshot.
  var data = sheet.getDataRange().getValues()
  var headers = data.length ? data[0] : []
  return { sheet: sheet, headers: headers, data: data, idIdx: headers.indexOf('id') }
}

function appendObject(context, body) {
  var row = context.headers.map(function (header) {
    if (header === 'id') return nextId()
    var value = Array.isArray(body[header]) && header === 'assignedLessonIds' ? body[header].join(',') : body[header]
    return safeValue(value === undefined ? '' : value)
  })
  context.sheet.appendRow(row)
  var result = {}
  context.headers.forEach(function (header, index) {
    result[header] = row[index]
  })
  return result
}

function appendClientObject(context, body) {
  var frequency = Number(body.lessonsPerWeek === undefined ? 1 : body.lessonsPerWeek)
  if ([1, 2, 3].indexOf(frequency) === -1) throw new Error('Некорректная нагрузка')
  var paidAmount = body.paidAmount === undefined || body.paidAmount === '' ? 0 : Number(body.paidAmount)
  if (!isFinite(paidAmount) || paidAmount < 0) throw new Error('Некорректная сумма оплаты')
  var category = body.category || 'плавание'
  var totalLessons = 0
  var row = context.headers.map(function (header) {
    if (header === 'id') return nextId()
    if (header === 'lessonsPerWeek') return frequency
    if (header === 'paidAmount') return paidAmount
    if (header === 'totalLessons') return totalLessons
    if (header === 'remainingLessons') return totalLessons
    if (header === 'paid') return paidAmount > 0
    if (header === 'paymentBalance') return 0
    if (header === 'purchasedAt') return new Date().toISOString()
    if (header === 'receiptUrl') return ''
    if (header === 'attendanceHistory') return '[]'
    if (header === 'status') return 'Активен'
    var value = Array.isArray(body[header]) && header === 'assignedLessonIds' ? body[header].join(',') : body[header]
    return safeValue(value === undefined ? '' : value)
  })
  context.sheet.appendRow(row)
  var result = {}
  context.headers.forEach(function (header, index) {
    result[header] = row[index]
  })
  return result
}

function updateEntity(ss, actionToSheet, body, auth) {
  var context = sheetContext(ss, actionToSheet[body.action])
  var branchIdx = context.headers.indexOf('branchId')
  var rowIndex = findRowById(context.data, context.idIdx, body.id)
  if (rowIndex === -1) throw new Error('Не найдено')
  if (auth.role === 'coach' && branchIdx !== -1 && !branchMatches(auth, context.data[rowIndex][branchIdx])) {
    throw new Error('Доступ к филиалу запрещен')
  }
  var previousRow = context.data[rowIndex].slice()
  var row = previousRow.slice()
  // Subscription counters and payment balance are ledger-owned. A normal card
  // edit cannot overwrite them or desynchronise the client row from payments.
  var clientSubscriptionFields = [
    'id',
    'paidAmount',
    'totalLessons',
    'remainingLessons',
    'paid',
    'purchasedAt',
    'receiptUrl',
    'attendanceHistory',
    'paymentBalance',
  ]
  context.headers.forEach(function (header, index) {
    if (
      body[header] === undefined ||
      (body.action === 'updateClient' && clientSubscriptionFields.indexOf(header) !== -1)
    )
      return
    if (body.action === 'updateClient' && header === 'branchId') return
    var value = Array.isArray(body[header]) && header === 'assignedLessonIds' ? body[header].join(',') : body[header]
    row[index] = safeValue(value)
  })

  // lessonsPerWeek is only the tariff selected for a future payment. It must
  // never recalculate paid credits or the remaining balance of this client.
  var changedIndexes = writeChangedRowCells(context.sheet, rowIndex + 1, previousRow, row)
  if (!changedIndexes.length) return { success: true }
  try {
    auditAdminMutation(
      ss,
      body,
      auth,
      actionToSheet[body.action],
      String(previousRow[context.idIdx] || body.id),
      branchIdx === -1 ? '' : String(previousRow[branchIdx] || ''),
      changedIndexes.map(function (index) {
        return context.headers[index]
      }),
    )
  } catch (error) {
    try {
      writeChangedRowCells(context.sheet, rowIndex + 1, row, previousRow)
    } catch (rollbackError) {}
    throw error
  }
  return { success: true }
}

function assignClientLesson(ss, body, auth, knownLesson) {
  var clientContext = sheetContext(ss, 'Клиенты')
  var clientRowIndex = findRowById(clientContext.data, clientContext.idIdx, body.clientId)
  if (clientRowIndex === -1) throw new Error('Клиент не найден')
  var clientBranchIdx = clientContext.headers.indexOf('branchId')
  var clientBranchId = clientBranchIdx === -1 ? '' : String(clientContext.data[clientRowIndex][clientBranchIdx] || '')
  if (!branchMatches(auth, clientBranchId)) throw new Error('Доступ к филиалу запрещен')
  var clientStatusIdx = clientContext.headers.indexOf('status')
  if (clientStatusIdx !== -1 && String(clientContext.data[clientRowIndex][clientStatusIdx] || '') === 'Архив')
    throw new Error('Клиент в архиве')

  var lessonBranchId = ''
  if (knownLesson && String(knownLesson.id || '') === String(body.lessonId)) {
    lessonBranchId = String(knownLesson.branchId || '')
  } else {
    var lessonContext = sheetContext(ss, 'Расписание')
    var lessonRowIndex = findRowById(lessonContext.data, lessonContext.idIdx, body.lessonId)
    if (lessonRowIndex === -1) throw new Error('Занятие не найдено')
    var lessonBranchIdx = lessonContext.headers.indexOf('branchId')
    lessonBranchId = lessonBranchIdx === -1 ? '' : String(lessonContext.data[lessonRowIndex][lessonBranchIdx] || '')
  }
  if (!branchMatches(auth, lessonBranchId) || String(clientBranchId) !== String(lessonBranchId))
    throw new Error('Клиент и занятие должны принадлежать одному филиалу')

  var assignedIdsIdx = clientContext.headers.indexOf('assignedLessonIds')
  var assignedIdIdx = clientContext.headers.indexOf('assignedLessonId')
  if (assignedIdsIdx === -1 && assignedIdIdx === -1)
    throw new Error('Схема клиентов не обновлена. Запустите setupSchema()')
  var previousRow = clientContext.data[clientRowIndex].slice()
  var row = previousRow.slice()
  var previousValue = assignedIdsIdx === -1 ? row[assignedIdIdx] : row[assignedIdsIdx]
  if (!previousValue && assignedIdIdx !== -1) previousValue = row[assignedIdIdx]
  var assignedIds = String(previousValue || '')
    .split(',')
    .map(function (value) {
      return value.trim()
    })
    .filter(Boolean)
  if (assignedIds.indexOf(String(body.lessonId)) === -1) assignedIds.push(String(body.lessonId))
  if (assignedIdsIdx !== -1) row[assignedIdsIdx] = assignedIds.join(',')
  if (assignedIdIdx !== -1) row[assignedIdIdx] = assignedIds[0] || ''
  var changedIndexes = writeChangedRowCells(clientContext.sheet, clientRowIndex + 1, previousRow, row)
  if (!changedIndexes.length) return { success: true, alreadyAssigned: true }
  try {
    auditAdminMutation(
      ss,
      body,
      auth,
      'Клиенты',
      String(body.clientId),
      clientBranchId,
      changedIndexes.map(function (index) {
        return clientContext.headers[index]
      }),
    )
  } catch (error) {
    try {
      writeChangedRowCells(clientContext.sheet, clientRowIndex + 1, row, previousRow)
    } catch (rollbackError) {}
    throw error
  }
  return { success: true, alreadyAssigned: false }
}

function createLessonWithOptionalClient(ss, body, auth) {
  var lessonContext = sheetContext(ss, 'Расписание')
  ;['date', 'dayOfWeek', 'time', 'category', 'isRecurring'].forEach(function (header) {
    if (lessonContext.headers.indexOf(header) === -1)
      throw new Error('Схема расписания не обновлена. Запустите setupSchema(): ' + header)
  })
  var createdLessonRow = lessonContext.sheet.getLastRow() + 1
  var createdLesson = appendObject(lessonContext, body)
  var clientId = String(body.clientId || '').trim()
  if (!clientId) return createdLesson

  // Client assignment remains an administrator-only operation, but is done
  // inside the same signed request and mutation lock as lesson creation.
  if (!auth || auth.role !== 'admin') {
    if (lessonContext.sheet.getLastRow() >= createdLessonRow) lessonContext.sheet.deleteRow(createdLessonRow)
    throw new Error('Недостаточно прав')
  }

  try {
    var assignment = assignClientLesson(
      ss,
      {
        action: 'assignClientLesson',
        requestId: String(body.requestId) + ':client',
        clientId: clientId,
        lessonId: String(createdLesson.id),
      },
      auth,
      createdLesson,
    )
    createdLesson.clientAssigned = assignment.success === true
    return createdLesson
  } catch (error) {
    // Do not leave an orphan lesson when client validation or assignment fails.
    try {
      if (lessonContext.sheet.getLastRow() >= createdLessonRow) lessonContext.sheet.deleteRow(createdLessonRow)
    } catch (rollbackError) {}
    throw error
  }
}

function clientHasRelatedRows(sheet, clientId) {
  if (!sheet) return false
  var parsed = sheetObjects(sheet)
  var clientIdIdx = parsed.headers.indexOf('clientId')
  if (clientIdIdx === -1) return false
  return parsed.rows.some(function (row) {
    return String(row[clientIdIdx] || '') === String(clientId)
  })
}

function assertClientCanBeDeleted(ss, context, rowIndex) {
  var row = context.data[rowIndex]
  var clientId = String(row[context.idIdx] || '')
  var hasPayments = clientHasRelatedRows(ss.getSheetByName('Платежи'), clientId)
  var hasLedger = clientHasRelatedRows(ss.getSheetByName('Журнал занятий'), clientId)
  var hasAttendanceRows = clientHasRelatedRows(ss.getSheetByName('Посещения'), clientId)
  var historyIdx = context.headers.indexOf('attendanceHistory')
  var hasLegacyAttendance = historyIdx !== -1 && parseHistory(row[historyIdx]).length > 0
  var assignedIdsIdx = context.headers.indexOf('assignedLessonIds')
  var assignedIdIdx = context.headers.indexOf('assignedLessonId')
  var hasAssignment =
    (assignedIdsIdx !== -1 && String(row[assignedIdsIdx] || '').trim()) ||
    (assignedIdIdx !== -1 && String(row[assignedIdIdx] || '').trim())
  var paidAmountIdx = context.headers.indexOf('paidAmount')
  var totalLessonsIdx = context.headers.indexOf('totalLessons')
  var remainingLessonsIdx = context.headers.indexOf('remainingLessons')
  var paymentBalanceIdx = context.headers.indexOf('paymentBalance')
  var paidIdx = context.headers.indexOf('paid')
  var receiptIdx = context.headers.indexOf('receiptUrl')
  var hasLegacyFinancialData =
    (paidAmountIdx !== -1 && Number(row[paidAmountIdx] || 0) !== 0) ||
    (totalLessonsIdx !== -1 && Number(row[totalLessonsIdx] || 0) !== 0) ||
    (remainingLessonsIdx !== -1 && Number(row[remainingLessonsIdx] || 0) !== 0) ||
    (paymentBalanceIdx !== -1 && Number(row[paymentBalanceIdx] || 0) !== 0) ||
    (paidIdx !== -1 &&
      (row[paidIdx] === true || String(row[paidIdx] || '').toLowerCase() === 'true' || String(row[paidIdx]) === '1')) ||
    (receiptIdx !== -1 && String(row[receiptIdx] || '').trim())
  if (hasPayments || hasLedger || hasAttendanceRows || hasLegacyAttendance || hasAssignment || hasLegacyFinancialData) {
    throw new Error('Карточка не пустая: есть платежи, посещения или связь с расписанием. Архивируйте клиента.')
  }
}

function deleteEntity(ss, actionToSheet, body, auth) {
  var context = sheetContext(ss, actionToSheet[body.action])
  var branchIdx = context.headers.indexOf('branchId')
  var rowIndex = findRowById(context.data, context.idIdx, body.id)
  if (rowIndex === -1) throw new Error('Не найдено')
  if (auth.role === 'coach' && branchIdx !== -1 && !branchMatches(auth, context.data[rowIndex][branchIdx])) {
    throw new Error('Доступ к филиалу запрещен')
  }
  if (body.action === 'deleteClient') assertClientCanBeDeleted(ss, context, rowIndex)
  if (body.action === 'deleteCoach') {
    var userIdIdx = context.headers.indexOf('userId')
    var linkedUserId = userIdIdx === -1 ? '' : String(context.data[rowIndex][userIdIdx] || '').trim()
    if (linkedUserId) deactivateCoachUser(ss, linkedUserId, auth, body)
  }
  context.sheet.deleteRow(rowIndex + 1)
  return { success: true }
}
function getCoachUserContext(ss, userId) {
  var sheet = getOrCreateUsersSheet(ss)
  var headers = requireUsersAccessColumns(sheet)
  var data = sheet.getDataRange().getValues()
  var idIdx = headers.indexOf('id')
  var rowIndex = findRowById(data, idIdx, userId)
  if (rowIndex === -1) throw new Error('Аккаунт не найден')
  var roleIdx = headers.indexOf('role')
  if (normalizeRole(data[rowIndex][roleIdx]) !== 'coach') throw new Error('Можно управлять только аккаунтом тренера')
  return { sheet: sheet, headers: headers, data: data, rowIndex: rowIndex }
}

function deactivateCoachUser(ss, userId, auth, body) {
  var context = getCoachUserContext(ss, userId)
  var statusIdx = context.headers.indexOf('status')
  var disabledAtIdx = context.headers.indexOf('disabledAt')
  var disabledByIdx = context.headers.indexOf('disabledBy')
  var previousRow = context.data[context.rowIndex].slice()
  var row = previousRow.slice()
  if (
    String(row[statusIdx] || '') === 'Отключен' &&
    row[disabledAtIdx] &&
    String(row[disabledByIdx] || '') === String(auth.username || '')
  ) {
    return { success: true, duplicate: true }
  }
  row[statusIdx] = 'Отключен'
  row[disabledAtIdx] = new Date().toISOString()
  row[disabledByIdx] = safeValue(auth.username)
  var changedIndexes = writeChangedRowCells(context.sheet, context.rowIndex + 1, previousRow, row)
  try {
    auditAdminMutation(
      ss,
      body,
      auth,
      'Users',
      String(userId),
      String(row[context.headers.indexOf('branchId')] || ''),
      changedIndexes.map(function (index) {
        return context.headers[index]
      }),
    )
  } catch (error) {
    try {
      writeChangedRowCells(context.sheet, context.rowIndex + 1, row, previousRow)
    } catch (rollbackError) {}
    throw error
  }
  invalidateAuthUserCache(String(userId))
  return { success: true }
}

function activateCoachUser(ss, userId, auth, body) {
  var context = getCoachUserContext(ss, userId)
  var statusIdx = context.headers.indexOf('status')
  var disabledAtIdx = context.headers.indexOf('disabledAt')
  var disabledByIdx = context.headers.indexOf('disabledBy')
  var previousRow = context.data[context.rowIndex].slice()
  var row = previousRow.slice()
  if (String(row[statusIdx] || '') === 'Ожидает подтверждения') {
    var branchId = String(row[context.headers.indexOf('branchId')] || '').trim()
    if (!branchId) throw new Error('У пользователя не назначен филиал')
    assertBranchExists(ss, branchId)
  }
  row[statusIdx] = 'Активен'
  row[disabledAtIdx] = ''
  row[disabledByIdx] = ''
  var changedIndexes = writeChangedRowCells(context.sheet, context.rowIndex + 1, previousRow, row)
  if (!changedIndexes.length) return { success: true, duplicate: true }
  try {
    auditAdminMutation(
      ss,
      body,
      auth,
      'Users',
      String(userId),
      String(row[context.headers.indexOf('branchId')] || ''),
      changedIndexes.map(function (index) {
        return context.headers[index]
      }),
    )
  } catch (error) {
    try {
      writeChangedRowCells(context.sheet, context.rowIndex + 1, row, previousRow)
    } catch (rollbackError) {}
    throw error
  }
  invalidateAuthUserCache(String(userId))
  return { success: true }
}

function resetCoachPassword(ss, userId, passwordHash, auth, body) {
  var context = getCoachUserContext(ss, userId)
  var passwordIdx = context.headers.indexOf('password')
  var previousRow = context.data[context.rowIndex].slice()
  var row = previousRow.slice()
  row[passwordIdx] = String(passwordHash)
  var changedIndexes = writeChangedRowCells(context.sheet, context.rowIndex + 1, previousRow, row)
  if (!changedIndexes.length) return { success: true, duplicate: true }
  try {
    // The audit contains only the column name, never a password or its hash.
    auditAdminMutation(
      ss,
      body,
      auth,
      'Users',
      String(userId),
      String(row[context.headers.indexOf('branchId')] || ''),
      ['password'],
    )
  } catch (error) {
    try {
      writeChangedRowCells(context.sheet, context.rowIndex + 1, row, previousRow)
    } catch (rollbackError) {}
    throw error
  }
  invalidateAuthUserCache(String(userId))
  return { success: true }
}

function linkCoachUser(ss, coachId, userId, auth, body) {
  var coachSheet = requireExistingSheet(ss, 'Тренеры')
  var coachHeaders = requireCoachUserIdColumn(coachSheet)
  var coachData = coachSheet.getDataRange().getValues()
  var coachIdIdx = coachHeaders.indexOf('id')
  var coachRowIndex = findRowById(coachData, coachIdIdx, coachId)
  if (coachRowIndex === -1) throw new Error('Карточка тренера не найдена')

  var userContext = getCoachUserContext(ss, userId)
  var coachBranchIdx = coachHeaders.indexOf('branchId')
  var userBranchIdx = userContext.headers.indexOf('branchId')
  var coachBranchId = String(coachData[coachRowIndex][coachBranchIdx] || '').trim()
  var userBranchId = String(userContext.data[userContext.rowIndex][userBranchIdx] || '').trim()
  if (!coachBranchId || !userBranchId || coachBranchId !== userBranchId) {
    throw new Error('Аккаунт и карточка тренера должны относиться к одному филиалу')
  }

  var userIdIdx = coachHeaders.indexOf('userId')
  for (var i = 1; i < coachData.length; i++) {
    if (i !== coachRowIndex && String(coachData[i][userIdIdx] || '').trim() === String(userId)) {
      throw new Error('Этот аккаунт уже связан с другой карточкой тренера')
    }
  }
  var previousRow = coachData[coachRowIndex].slice()
  var row = previousRow.slice()
  row[userIdIdx] = String(userId)
  var changedIndexes = writeChangedRowCells(coachSheet, coachRowIndex + 1, previousRow, row)
  if (!changedIndexes.length) return { success: true, duplicate: true }
  try {
    auditAdminMutation(ss, body, auth, 'Тренеры', String(coachId), coachBranchId, ['userId'])
  } catch (error) {
    try {
      writeChangedRowCells(coachSheet, coachRowIndex + 1, row, previousRow)
    } catch (rollbackError) {}
    throw error
  }
  return { success: true }
}
function assignCoachUserBranch(ss, body, auth) {
  var assignmentSheet = getOrCreateUsersSheet(ss)
  var assignmentHeaders = requireUsersAccessColumns(assignmentSheet)
  var assignmentData = assignmentSheet.getDataRange().getValues()
  var assignmentIdIdx = assignmentHeaders.indexOf('id')
  var assignmentRoleIdx = assignmentHeaders.indexOf('role')
  var assignmentBranchIdx = assignmentHeaders.indexOf('branchId')
  assertBranchExists(ss, body.branchId)
  var assignmentRow = findRowById(assignmentData, assignmentIdIdx, body.userId)
  if (assignmentRow === -1) throw new Error('Аккаунт не найден')
  if (normalizeRole(assignmentData[assignmentRow][assignmentRoleIdx]) !== 'coach')
    throw new Error('Можно назначать филиал только тренеру')
  var previousRow = assignmentData[assignmentRow].slice()
  var row = previousRow.slice()
  row[assignmentBranchIdx] = safeValue(body.branchId)
  var changedIndexes = writeChangedRowCells(assignmentSheet, assignmentRow + 1, previousRow, row)
  if (!changedIndexes.length) return { success: true, duplicate: true }
  try {
    auditAdminMutation(ss, body, auth, 'Users', String(body.userId), String(body.branchId), ['branchId'])
  } catch (error) {
    try {
      writeChangedRowCells(assignmentSheet, assignmentRow + 1, row, previousRow)
    } catch (rollbackError) {}
    throw error
  }
  invalidateAuthUserCache(String(body.userId || '').trim())
  return { success: true }
}

function registerPendingCoachUser(ss, body) {
  var sheet = requireExistingSheet(ss, 'Users')
  var data = sheet.getDataRange().getValues()
  var headers = requireUsersAccessHeaders(data[0] || [])
  var username = String(body.username || '').trim().toLowerCase()
  var usernameIdx = headers.indexOf('username')
  // Username is the durable natural idempotency key under the mutation lock.
  // A retry hashes the password with a new salt; never compare those hashes or
  // overwrite ANY existing account. The same reply prevents user enumeration.
  if (data.slice(1).some(function (row) {
    return String(row[usernameIdx] || '').trim().toLowerCase() === username
  })) return { status: 'success', pending: true }
  var row = headers.map(function (header) {
    if (header === 'id') return nextId()
    if (header === 'username') return username
    if (header === 'password') return String(body.passwordHash)
    if (header === 'role') return '2'
    if (header === 'status') return 'Ожидает подтверждения'
    return ''
  })
  // One append only: no orphan coach card or partially-written second sheet.
  sheet.appendRow(row)
  diagnosticLog('registration.pending_created', {})
  return { status: 'success', pending: true }
}

function createCoachWithOptionalAccount(ss, body) {
  var coachSheet = requireExistingSheet(ss, 'Тренеры')
  var coachHeaders = requireCoachUserIdColumn(coachSheet)
  var userId = ''
  var userSheet = null
  var userRowIndex = -1
  try {
    if (body.username) {
      userSheet = getOrCreateUsersSheet(ss)
      var userHeaders = requireUsersAccessColumns(userSheet)
      var userData = userSheet.getDataRange().getValues()
      var usernameIdx = userHeaders.indexOf('username')
      if (
        userData.slice(1).some(function (row) {
          return (
            String(row[usernameIdx] || '')
              .trim()
              .toLowerCase() === String(body.username).trim().toLowerCase()
          )
        })
      )
        throw new Error('Пользователь с таким логином уже существует')
      userId = nextId()
      var userRow = userHeaders.map(function (header) {
        if (header === 'id') return userId
        if (header === 'username') return safeValue(body.username)
        if (header === 'password') return String(body.passwordHash)
        if (header === 'role') return '2'
        if (header === 'branchId') return safeValue(body.branchId)
        if (header === 'status') return 'Активен'
        return ''
      })
      userSheet.appendRow(userRow)
      userRowIndex = userSheet.getLastRow()
    }
    var coachRow = coachHeaders.map(function (header) {
      if (header === 'id') return nextId()
      if (header === 'userId') return userId
      var value = body[header]
      return safeValue(value === undefined ? '' : value)
    })
    coachSheet.appendRow(coachRow)
    var coach = {}
    coachHeaders.forEach(function (header, index) {
      // safeValue prefixes formula-like strings for Sheets. Return the
      // display phone to the UI without that storage-only apostrophe.
      coach[header] = header === 'phone' ? String(body.phone || '') : coachRow[index]
    })
    return coach
  } catch (error) {
    if (userSheet && userRowIndex > 0 && userSheet.getLastRow() >= userRowIndex) {
      try {
        userSheet.deleteRow(userRowIndex)
      } catch (rollbackError) {}
    }
    throw error
  }
}

function uploadReceipt(ss, body) {
  var context = sheetContext(ss, 'Клиенты')
  var headers = context.headers
  var rowIndex = findRowById(context.data, context.idIdx, body.clientId)
  if (rowIndex === -1) throw new Error('Клиент не найден')
  if (!body.fileBase64 || !body.fileName || !body.mimeType) throw new Error('Файл обязателен')
  if (String(body.fileBase64).length > 7 * 1024 * 1024 || String(body.fileName).length > 200)
    throw new Error('Файл слишком большой')
  if (['image/jpeg', 'image/png', 'application/pdf'].indexOf(String(body.mimeType)) === -1)
    throw new Error('Недопустимый тип файла')
  var receiptIdx = headers.indexOf('receiptUrl')
  if (receiptIdx === -1) throw new Error('Схема клиентов не обновлена. Запустите setupSchema()')
  if (context.data[rowIndex][receiptIdx]) revokeReceiptAccess(context.data[rowIndex][receiptIdx])
  var bytes = Utilities.base64Decode(body.fileBase64)
  if (bytes.length > 5 * 1024 * 1024) throw new Error('Файл слишком большой')
  var file = DriveApp.createFile(Utilities.newBlob(bytes, body.mimeType, body.fileName))
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE)
  // A receipt is evidence only. It never changes lessons, money balance or status.
  context.sheet.getRange(rowIndex + 1, receiptIdx + 1).setValue('drive:' + file.getId())
  return { success: true }
}

function finiteNumber(value) {
  var number = Number(value)
  return isFinite(number) ? number : 0
}

function hasLedgerValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

// Request-local only, built after acquiring the mutation lock. Partition
// once, then reconcile only this client's rows; no cached accounting state.
// Preserve physical row indices so audit diagnostics still name the right row.
function accountingRowsByClient(parsed, selectedClients) {
  var clientIdx = parsed.headers.indexOf('clientId')
  var byClient = Object.create(null)
  parsed.rows.forEach(function (row, index) {
    var key = String(row[clientIdx] || '')
    if (selectedClients && !selectedClients[key]) return
    if (!byClient[key]) byClient[key] = { headers: parsed.headers, rows: [], sourceRowIndices: [] }
    byClient[key].rows.push(row)
    byClient[key].sourceRowIndices.push(index)
  })
  return byClient
}

function accountingClientRows(byClient, headers, clientId) {
  return byClient[String(clientId)] || { headers: headers, rows: [], sourceRowIndices: [] }
}

function accountingSourceIndex(parsed, index) {
  return parsed.sourceRowIndices && parsed.sourceRowIndices[index] !== undefined
    ? parsed.sourceRowIndices[index]
    : index
}

function ledgerTotalDelta(row, headers) {
  var type = String(row[headers.indexOf('type')] || '')
  var explicitIdx = headers.indexOf('totalLessonsDelta')
  if (explicitIdx !== -1 && hasLedgerValue(row[explicitIdx])) return finiteNumber(row[explicitIdx])
  // Schema 7 purchase rows did not have totalLessonsDelta. Their credit was
  // the same as the purchase delta; this read-only compatibility rule keeps
  // the audit truthful without rewriting historical data.
  return type === 'purchase' || type === 'purchase_repair' || type === 'adjustment'
    ? finiteNumber(row[headers.indexOf('lessonsDelta')])
    : 0
}

function calculateLessonLedgerState(ledger, clientId) {
  var headers = ledger.headers
  var clientIdx = headers.indexOf('clientId')
  var deltaIdx = headers.indexOf('lessonsDelta')
  var balanceBeforeIdx = headers.indexOf('balanceBefore')
  var balanceAfterIdx = headers.indexOf('balanceAfter')
  var totalBeforeIdx = headers.indexOf('totalLessonsBefore')
  var totalAfterIdx = headers.indexOf('totalLessonsAfter')
  var state = { balance: 0, totalLessons: 0, rows: [], issues: [] }
  ledger.rows.forEach(function (row, index) {
    index = accountingSourceIndex(ledger, index)
    if (String(row[clientIdx] || '') !== String(clientId)) return
    if (!hasLedgerValue(row[deltaIdx]) || !isFinite(Number(row[deltaIdx]))) {
      state.issues.push('Строка журнала ' + String(index + 2) + ' содержит некорректное движение занятий')
      return
    }
    var delta = Number(row[deltaIdx])
    var totalDelta = ledgerTotalDelta(row, headers)
    if (
      balanceBeforeIdx !== -1 &&
      hasLedgerValue(row[balanceBeforeIdx]) &&
      Number(row[balanceBeforeIdx]) !== state.balance
    ) {
      state.issues.push('Строка журнала ' + String(index + 2) + ' содержит неверный остаток до операции')
    }
    if (
      totalBeforeIdx !== -1 &&
      hasLedgerValue(row[totalBeforeIdx]) &&
      Number(row[totalBeforeIdx]) !== state.totalLessons
    ) {
      state.issues.push('Строка журнала ' + String(index + 2) + ' содержит неверное число занятий до операции')
    }
    state.balance += delta
    state.totalLessons += totalDelta
    if (
      balanceAfterIdx !== -1 &&
      hasLedgerValue(row[balanceAfterIdx]) &&
      Number(row[balanceAfterIdx]) !== state.balance
    ) {
      state.issues.push('Строка журнала ' + String(index + 2) + ' содержит неверный остаток после операции')
    }
    if (
      totalAfterIdx !== -1 &&
      hasLedgerValue(row[totalAfterIdx]) &&
      Number(row[totalAfterIdx]) !== state.totalLessons
    ) {
      state.issues.push(
        'Строка журнала ' + String(index + 2) + ' содержит неверное число начисленных занятий после операции',
      )
    }
    state.rows.push({ row: row, index: index, delta: delta, totalDelta: totalDelta })
  })
  return state
}

function reconcilePaymentsWithLedger(payments, ledger, clientId) {
  var paymentHeaders = payments.headers,
    ledgerHeaders = ledger.headers
  var paymentIdIdx = paymentHeaders.indexOf('id'),
    paymentClientIdx = paymentHeaders.indexOf('clientId')
  var paymentLessonsIdx = paymentHeaders.indexOf('lessonsAdded')
  var ledgerClientIdx = ledgerHeaders.indexOf('clientId'),
    ledgerPaymentIdx = ledgerHeaders.indexOf('paymentId')
  var ledgerTypeIdx = ledgerHeaders.indexOf('type'),
    ledgerDeltaIdx = ledgerHeaders.indexOf('lessonsDelta')
  var byPayment = Object.create(null)
  ledger.rows.forEach(function (row, index) {
    index = accountingSourceIndex(ledger, index)
    if (String(row[ledgerClientIdx] || '') !== String(clientId)) return
    var paymentId = String(row[ledgerPaymentIdx] || '')
    var type = String(row[ledgerTypeIdx] || '')
    if ((type === 'purchase' || type === 'purchase_repair') && paymentId) {
      if (!byPayment[paymentId]) byPayment[paymentId] = []
      byPayment[paymentId].push({ row: row, index: index })
    }
  })
  var missingPayments = [],
    issues = []
  payments.rows.forEach(function (row, index) {
    index = accountingSourceIndex(payments, index)
    if (String(row[paymentClientIdx] || '') !== String(clientId)) return
    var paymentId = String(row[paymentIdIdx] || '')
    if (
      paymentLessonsIdx === -1 ||
      !hasLedgerValue(row[paymentLessonsIdx]) ||
      !isFinite(Number(row[paymentLessonsIdx]))
    ) {
      issues.push('Платёж ' + paymentId + ' не содержит корректного числа начисленных занятий')
      return
    }
    var expected = Number(row[paymentLessonsIdx])
    var entries = byPayment[paymentId] || []
    if (entries.length === 0) {
      missingPayments.push({ id: paymentId, lessonsAdded: expected, row: row, index: index })
      return
    }
    var actual = entries.reduce(function (sum, entry) {
      return sum + finiteNumber(entry.row[ledgerDeltaIdx])
    }, 0)
    if (entries.length !== 1 || actual !== expected) {
      issues.push('Платёж ' + paymentId + ' не совпадает с журналом занятий')
    }
    delete byPayment[paymentId]
  })
  Object.keys(byPayment).forEach(function (paymentId) {
    issues.push('В журнале есть покупка без подтверждённого платежа: ' + paymentId)
  })
  return { missingPayments: missingPayments, issues: issues }
}

function clientLedgerReconciliation(clientRow, clientHeaders, ledger, payments, clientId) {
  var state = calculateLessonLedgerState(ledger, clientId)
  var paymentCheck = reconcilePaymentsWithLedger(payments, ledger, clientId)
  var currentRemaining = finiteNumber(clientRow[clientHeaders.indexOf('remainingLessons')])
  var currentTotal = finiteNumber(clientRow[clientHeaders.indexOf('totalLessons')])
  return {
    ledgerState: state,
    paymentCheck: paymentCheck,
    currentRemainingLessons: currentRemaining,
    currentTotalLessons: currentTotal,
    calculatedRemainingLessons: state.balance,
    calculatedTotalLessons: state.totalLessons,
    ledgerIssues: state.issues,
    paymentIssues: paymentCheck.issues,
    missingPayments: paymentCheck.missingPayments,
    isConsistent:
      state.issues.length === 0 &&
      paymentCheck.issues.length === 0 &&
      paymentCheck.missingPayments.length === 0 &&
      currentRemaining === state.balance &&
      currentTotal === state.totalLessons,
  }
}

function assertClientLedgerReconciled(clientRow, clientHeaders, ledger, payments, clientId, knownReconciliation) {
  var reconciliation = knownReconciliation || clientLedgerReconciliation(clientRow, clientHeaders, ledger, payments, clientId)
  if (!reconciliation.isConsistent) {
    throw new Error('Остаток абонемента требует сверки с журналом. Выполните аудит и подтверждённое исправление.')
  }
  return reconciliation
}

// Bring a legacy card into the ledger before its first new attendance write.
// Confirmed payment rows are restored first; any historical usage that only
// exists in the old card is then recorded as one reconciliation movement.
// Client balances and payment amounts are never changed or invented here.
function prepareLegacyLedgerBaseline(ledger, payments, clientRow, clientHeaders, clientId, auth, knownReconciliation) {
  var remainingIdx = clientHeaders.indexOf('remainingLessons')
  var totalIdx = clientHeaders.indexOf('totalLessons')
  var branchIdx = clientHeaders.indexOf('branchId')
  var purchasedAtIdx = clientHeaders.indexOf('purchasedAt')
  var remaining = finiteNumber(clientRow[remainingIdx])
  var total = finiteNumber(clientRow[totalIdx])
  if (remaining < 0 || total < 0 || remaining > total) {
    throw new Error('Остаток абонемента требует сверки с журналом. Выполните аудит и подтверждённое исправление.')
  }

  var state = knownReconciliation ? knownReconciliation.ledgerState : calculateLessonLedgerState(ledger, clientId)
  var paymentCheck = knownReconciliation ? knownReconciliation.paymentCheck : reconcilePaymentsWithLedger(payments, ledger, clientId)
  var alreadyConsistent =
    state.issues.length === 0 &&
    paymentCheck.issues.length === 0 &&
    paymentCheck.missingPayments.length === 0 &&
    state.balance === remaining &&
    state.totalLessons === total
  if (alreadyConsistent) return []
  if (state.issues.length || paymentCheck.issues.length) return []
  // Once a client has ledger movements, discrepancies require a confirmed
  // admin audit. An empty purchasedAt must never permit repeated migration.
  if (state.rows.length > 0) return []

  var isLegacyCard =
    purchasedAtIdx === -1 ||
    !String(clientRow[purchasedAtIdx] || '').trim() ||
    state.rows.length === 0 ||
    paymentCheck.missingPayments.length > 0
  if (!isLegacyCard) return []

  var branchId = branchIdx === -1 ? '' : String(clientRow[branchIdx] || '')
  var preparedEntries = []
  paymentCheck.missingPayments.forEach(function (payment) {
    var currentState = calculateLessonLedgerState(ledger, clientId)
    var paymentFingerprint = sha256(
      JSON.stringify({ clientId: String(clientId), paymentId: String(payment.id), lessonsAdded: payment.lessonsAdded }),
    )
    var restoredEntry = {
      requestId: 'legacy-payment:' + String(payment.id),
      clientId: clientId,
      branchId: branchId,
      paymentId: payment.id,
      type: 'purchase_repair',
      lessonsDelta: payment.lessonsAdded,
      totalLessonsDelta: payment.lessonsAdded,
      balanceBefore: currentState.balance,
      balanceAfter: currentState.balance + payment.lessonsAdded,
      totalLessonsBefore: currentState.totalLessons,
      totalLessonsAfter: currentState.totalLessons + payment.lessonsAdded,
      recordedBy: auth.username,
      comment: 'Восстановлен подтверждённый платёж старой карточки',
      reason: 'Автоматическая миграция перед первой новой отметкой посещения',
      requestFingerprint: paymentFingerprint,
    }
    ledger.rows.push(lessonLedgerRow(ledger.headers, restoredEntry))
    preparedEntries.push(restoredEntry)
  })

  state = calculateLessonLedgerState(ledger, clientId)
  var balanceDelta = remaining - state.balance
  var totalDelta = total - state.totalLessons
  if (balanceDelta !== 0 || totalDelta !== 0 || state.rows.length === 0) {
    var fingerprint = sha256(
      JSON.stringify({ clientId: String(clientId), remainingLessons: remaining, totalLessons: total }),
    )
    var baselineEntry = {
      requestId: 'legacy-opening:' + String(clientId),
      clientId: clientId,
      branchId: branchId,
      type: state.rows.length === 0 ? 'legacy_opening_balance' : 'legacy_balance_reconciliation',
      lessonsDelta: balanceDelta,
      totalLessonsDelta: totalDelta,
      balanceBefore: state.balance,
      balanceAfter: remaining,
      totalLessonsBefore: state.totalLessons,
      totalLessonsAfter: total,
      recordedBy: auth.username,
      comment: 'Зафиксирован фактический остаток старой карточки',
      reason: 'Автоматическая миграция перед первой новой отметкой посещения',
      requestFingerprint: fingerprint,
    }
    ledger.rows.push(lessonLedgerRow(ledger.headers, baselineEntry))
    preparedEntries.push(baselineEntry)
  }
  diagnosticLog('attendance.legacy_ledger_prepared', {
    clientRef: sha256(String(clientId)).substring(0, 12),
    rowsPrepared: preparedEntries.length,
  })
  return preparedEntries
}

function ledgerRequestRow(ledger, requestId) {
  var requestIdx = ledger.headers.indexOf('requestId')
  for (var i = 0; i < ledger.rows.length; i++) {
    if (String(ledger.rows[i][requestIdx] || '') === String(requestId)) return { row: ledger.rows[i], index: i }
  }
  return null
}

function recordAdjustment(ss, body, auth) {
  var clientContext = sheetContext(ss, 'Клиенты')
  requireClientSubscriptionColumns(clientContext.sheet)
  var rowIndex = findRowById(clientContext.data, clientContext.idIdx, body.clientId)
  if (rowIndex === -1) throw new Error('Клиент не найден')
  var branchIdx = clientContext.headers.indexOf('branchId')
  var branchId = String(clientContext.data[rowIndex][branchIdx] || '')
  if (!branchMatches(auth, branchId)) throw new Error('Доступ к филиалу запрещен')
  var ledgerSheet = requireExistingSheet(ss, 'Журнал занятий')
  requireLessonLedgerColumns(ledgerSheet)
  var paymentSheet = requireExistingSheet(ss, 'Платежи')
  var ledger = sheetObjects(ledgerSheet),
    payments = sheetObjects(paymentSheet)
  var fingerprint = sha256(
    JSON.stringify({
      actorId: String(auth.id),
      clientId: String(body.clientId),
      lessonsDelta: Number(body.lessonsDelta),
      reason: String(body.reason),
    }),
  )
  var existing = ledgerRequestRow(ledger, body.requestId)
  if (existing) {
    var fingerprintIdx = ledger.headers.indexOf('requestFingerprint')
    if (String(existing.row[fingerprintIdx] || '') !== fingerprint)
      throw new Error('Этот requestId уже использован с другими данными')
    return { success: true, duplicate: true }
  }
  var row = clientContext.data[rowIndex].slice()
  assertClientLedgerReconciled(row, clientContext.headers, ledger, payments, body.clientId)
  var remainingIdx = clientContext.headers.indexOf('remainingLessons')
  var totalIdx = clientContext.headers.indexOf('totalLessons')
  var statusIdx = clientContext.headers.indexOf('status')
  var delta = Number(body.lessonsDelta)
  var nextRemaining = Number(row[remainingIdx]) + delta
  var nextTotal = Number(row[totalIdx]) + delta
  if (nextRemaining < 0 || nextTotal < 0 || nextTotal < nextRemaining)
    throw new Error('Корректировка приводит к недопустимому остатку занятий')
  row[remainingIdx] = nextRemaining
  row[totalIdx] = nextTotal
  if (statusIdx !== -1 && String(row[statusIdx] || '') !== 'Архив')
    row[statusIdx] = nextRemaining > 0 ? 'Активен' : 'Пауза'
  var originalRow = clientContext.data[rowIndex].slice()
  var appendedLedgerRow = -1
  try {
    writeChangedRowCells(clientContext.sheet, rowIndex + 1, originalRow, row)
    appendedLedgerRow = appendLessonLedgerEntry(ledgerSheet, {
      requestId: body.requestId,
      clientId: body.clientId,
      branchId: branchId,
      type: 'adjustment',
      lessonsDelta: delta,
      totalLessonsDelta: delta,
      balanceBefore: Number(originalRow[remainingIdx] || 0),
      balanceAfter: nextRemaining,
      totalLessonsBefore: Number(originalRow[totalIdx] || 0),
      totalLessonsAfter: nextTotal,
      recordedBy: auth.username,
      comment: String(body.comment || ''),
      reason: String(body.reason),
      requestFingerprint: fingerprint,
    }).rowIndex
  } catch (error) {
    try {
      writeChangedRowCells(clientContext.sheet, rowIndex + 1, row, originalRow)
      if (appendedLedgerRow !== -1 && ledgerSheet.getLastRow() >= appendedLedgerRow)
        ledgerSheet.deleteRow(appendedLedgerRow)
    } catch (rollbackError) {}
    throw error
  }
  return { success: true, client: { remainingLessons: nextRemaining, totalLessons: nextTotal, status: row[statusIdx] } }
}

function auditLessonLedger(ss, body, auth) {
  var clientContext = sheetContext(ss, 'Клиенты')
  requireClientSubscriptionColumns(clientContext.sheet)
  var ledgerSheet = requireExistingSheet(ss, 'Журнал занятий')
  requireLessonLedgerColumns(ledgerSheet)
  var paymentSheet = requireExistingSheet(ss, 'Платежи')
  var ledger = sheetObjects(ledgerSheet),
    payments = sheetObjects(paymentSheet)
  var branchIdx = clientContext.headers.indexOf('branchId'),
    nameIdx = clientContext.headers.indexOf('childName')
  var discrepancies = []
  clientContext.data.slice(1).forEach(function (row) {
    var clientId = String(row[clientContext.idIdx] || '')
    if (!clientId || (body.clientId && clientId !== String(body.clientId))) return
    if (!branchMatches(auth, row[branchIdx])) return
    var reconciliation = clientLedgerReconciliation(row, clientContext.headers, ledger, payments, clientId)
    if (reconciliation.isConsistent) return
    discrepancies.push({
      clientId: clientId,
      childName: String(row[nameIdx] || ''),
      branchId: String(row[branchIdx] || ''),
      current: {
        remainingLessons: reconciliation.currentRemainingLessons,
        totalLessons: reconciliation.currentTotalLessons,
      },
      calculated: {
        remainingLessons: reconciliation.calculatedRemainingLessons,
        totalLessons: reconciliation.calculatedTotalLessons,
      },
      ledgerIssues: reconciliation.ledgerIssues,
      paymentIssues: reconciliation.paymentIssues,
      missingPaymentIds: reconciliation.missingPayments.map(function (payment) {
        return payment.id
      }),
      repairable: reconciliation.ledgerIssues.length === 0 && reconciliation.paymentIssues.length === 0,
    })
  })
  return { success: true, checked: body.clientId ? 1 : clientContext.data.length - 1, discrepancies: discrepancies }
}

function repairLessonLedger(ss, body, auth) {
  var clientContext = sheetContext(ss, 'Клиенты')
  requireClientSubscriptionColumns(clientContext.sheet)
  var rowIndex = findRowById(clientContext.data, clientContext.idIdx, body.clientId)
  if (rowIndex === -1) throw new Error('Клиент не найден')
  var branchIdx = clientContext.headers.indexOf('branchId')
  var branchId = String(clientContext.data[rowIndex][branchIdx] || '')
  if (!branchMatches(auth, branchId)) throw new Error('Доступ к филиалу запрещен')
  var ledgerSheet = requireExistingSheet(ss, 'Журнал занятий')
  requireLessonLedgerColumns(ledgerSheet)
  var paymentSheet = requireExistingSheet(ss, 'Платежи')
  var ledger = sheetObjects(ledgerSheet),
    payments = sheetObjects(paymentSheet)
  var fingerprint = sha256(
    JSON.stringify({
      actorId: String(auth.id),
      clientId: String(body.clientId),
      expectedRemainingLessons: Number(body.expectedRemainingLessons),
      expectedTotalLessons: Number(body.expectedTotalLessons),
      reason: String(body.reason),
    }),
  )
  var existing = ledgerRequestRow(ledger, body.requestId)
  if (existing) {
    var existingFingerprintIdx = ledger.headers.indexOf('requestFingerprint')
    if (String(existing.row[existingFingerprintIdx] || '') !== fingerprint)
      throw new Error('Этот requestId уже использован с другими данными')
    return { success: true, duplicate: true }
  }
  var row = clientContext.data[rowIndex].slice()
  var reconciliation = clientLedgerReconciliation(row, clientContext.headers, ledger, payments, body.clientId)
  if (reconciliation.ledgerIssues.length || reconciliation.paymentIssues.length) {
    throw new Error('Автоматическое исправление недоступно: журнал или подтверждённые платежи содержат противоречия')
  }
  if (
    Number(body.expectedRemainingLessons) !== reconciliation.currentRemainingLessons ||
    Number(body.expectedTotalLessons) !== reconciliation.currentTotalLessons
  ) {
    throw new Error('Результат аудита устарел. Запустите сверку повторно перед исправлением.')
  }
  var runningBalance = reconciliation.calculatedRemainingLessons
  var runningTotal = reconciliation.calculatedTotalLessons
  var appendedLedgerRows = []
  var statusIdx = clientContext.headers.indexOf('status')
  var originalStatus = statusIdx === -1 ? undefined : row[statusIdx]
  try {
    reconciliation.missingPayments.forEach(function (payment) {
      runningBalance += payment.lessonsAdded
      runningTotal += payment.lessonsAdded
      appendedLedgerRows.push(
        appendLessonLedgerEntry(ledgerSheet, {
          requestId: String(body.requestId) + ':payment:' + payment.id,
          clientId: body.clientId,
          branchId: branchId,
          paymentId: payment.id,
          type: 'purchase_repair',
          lessonsDelta: payment.lessonsAdded,
          totalLessonsDelta: payment.lessonsAdded,
          balanceBefore: runningBalance - payment.lessonsAdded,
          balanceAfter: runningBalance,
          totalLessonsBefore: runningTotal - payment.lessonsAdded,
          totalLessonsAfter: runningTotal,
          recordedBy: auth.username,
          comment: 'Восстановлена связь с подтверждённым платежом',
          reason: String(body.reason),
          requestFingerprint: fingerprint,
        }).rowIndex,
      )
    })
    var balanceDelta = reconciliation.currentRemainingLessons - runningBalance
    var totalDelta = reconciliation.currentTotalLessons - runningTotal
    // Always append a confirmation marker with the requestId, even if restoring
    // missing payment links already made the figures equal.
    appendedLedgerRows.push(
      appendLessonLedgerEntry(ledgerSheet, {
        requestId: body.requestId,
        clientId: body.clientId,
        branchId: branchId,
        type: 'audit_repair',
        lessonsDelta: balanceDelta,
        totalLessonsDelta: totalDelta,
        balanceBefore: runningBalance,
        balanceAfter: reconciliation.currentRemainingLessons,
        totalLessonsBefore: runningTotal,
        totalLessonsAfter: reconciliation.currentTotalLessons,
        recordedBy: auth.username,
        comment: 'Подтверждённое исправление по аудиту',
        reason: String(body.reason),
        requestFingerprint: fingerprint,
      }).rowIndex,
    )
    if (statusIdx !== -1 && String(row[statusIdx] || '') !== 'Архив') {
      row[statusIdx] = reconciliation.currentRemainingLessons > 0 ? 'Активен' : 'Пауза'
      clientContext.sheet.getRange(rowIndex + 1, statusIdx + 1).setValue(row[statusIdx])
    }
  } catch (error) {
    try {
      if (statusIdx !== -1 && originalStatus !== undefined)
        clientContext.sheet.getRange(rowIndex + 1, statusIdx + 1).setValue(originalStatus)
      appendedLedgerRows
        .sort(function (left, right) {
          return right - left
        })
        .forEach(function (rowIndex) {
          if (ledgerSheet.getLastRow() >= rowIndex) ledgerSheet.deleteRow(rowIndex)
        })
    } catch (rollbackError) {}
    throw error
  }
  return { success: true, repaired: true }
}

function recordPayment(ss, body, auth) {
  var clientContext
  var clientRowIndex = -1
  var previousRow
  var paymentSheet
  var ledgerSheet
  var paymentRowIndex = -1
  var ledgerRowIndex = -1
  try {
    var clientSheet = ss.getSheetByName('Клиенты')
    if (!clientSheet) throw new Error('Лист клиентов не найден')
    requireClientSubscriptionColumns(clientSheet)
    clientContext = sheetContext(ss, 'Клиенты')
    clientRowIndex = findRowById(clientContext.data, clientContext.idIdx, body.clientId)
    if (clientRowIndex === -1) throw new Error('Клиент не найден')
    var branchIdx = clientContext.headers.indexOf('branchId')
    var clientBranch = branchIdx === -1 ? '' : clientContext.data[clientRowIndex][branchIdx]
    if (!branchMatches(auth, clientBranch)) throw new Error('Доступ к филиалу запрещен')

    var row = clientContext.data[clientRowIndex].slice()
    previousRow = row.slice()
    var categoryIdx = clientContext.headers.indexOf('category')
    var frequencyIdx = clientContext.headers.indexOf('lessonsPerWeek')
    var amountIdx = clientContext.headers.indexOf('paidAmount')
    var totalIdx = clientContext.headers.indexOf('totalLessons')
    var remainingIdx = clientContext.headers.indexOf('remainingLessons')
    var paidIdx = clientContext.headers.indexOf('paid')
    var balanceIdx = clientContext.headers.indexOf('paymentBalance')
    var statusIdx = clientContext.headers.indexOf('status')
    var category = body.category || String(row[categoryIdx] || 'плавание')
    var frequency = body.lessonsPerWeek === undefined ? Number(row[frequencyIdx] || 1) : Number(body.lessonsPerWeek)
    var amount = Number(body.amount)
    var calculation = paymentCalculation(category, frequency, amount, row[balanceIdx] || 0)

    paymentSheet = requireExistingSheet(ss, 'Платежи')
    ledgerSheet = requireExistingSheet(ss, 'Журнал занятий')
    requireLessonLedgerColumns(ledgerSheet)
    var paymentHeaders = getHeaders(paymentSheet)
    var fingerprintIdx = paymentHeaders.indexOf('requestFingerprint')
    if (fingerprintIdx === -1) throw new Error('Схема платежей не обновлена. Запустите setupSchema()')
    var paymentFingerprint = sha256(
      JSON.stringify({
        actorId: String(auth.id),
        clientId: String(body.clientId),
        amount: amount,
        category: category,
        lessonsPerWeek: frequency,
        comment: String(body.comment || ''),
      }),
    )
    var paymentRows = paymentSheet.getDataRange().getValues()
    var paymentRequestIdx = paymentHeaders.indexOf('requestId')
    var paymentLedger = sheetObjects(ledgerSheet)
    assertClientLedgerReconciled(row, clientContext.headers, paymentLedger, sheetObjects(paymentSheet), body.clientId)
    var existingPaymentIndex = paymentRows.findIndex(function (paymentRow, index) {
      return index > 0 && String(paymentRow[paymentRequestIdx]) === safeValue(body.requestId)
    })
    if (existingPaymentIndex !== -1) {
      var existingPayment = paymentRows[existingPaymentIndex]
      if (String(existingPayment[fingerprintIdx]) !== paymentFingerprint)
        throw new Error('Этот requestId уже использован с другими данными')
      var existingId = String(existingPayment[paymentHeaders.indexOf('id')])
      var ledgerParsed = sheetObjects(ledgerSheet)
      var ledgerPaymentIdx = ledgerParsed.headers.indexOf('paymentId')
      if (
        !ledgerParsed.rows.some(function (ledgerRow) {
          return String(ledgerRow[ledgerPaymentIdx]) === existingId
        })
      ) {
        throw new Error('Платёж требует сверки с журналом занятий')
      }
      return {
        success: true,
        duplicate: true,
        payment: {
          id: existingId,
          clientId: String(body.clientId),
          amount: amount,
          category: category,
          lessonsPerWeek: frequency,
          lessonsAdded: Number(existingPayment[paymentHeaders.indexOf('lessonsAdded')] || 0),
          paidAt: existingPayment[paymentHeaders.indexOf('paidAt')],
        },
        client: {
          totalLessons: Number(row[totalIdx] || 0),
          remainingLessons: Number(row[remainingIdx] || 0),
          paidAmount: Number(row[amountIdx] || 0),
          paymentBalance: Number(row[balanceIdx] || 0),
          category: category,
          lessonsPerWeek: frequency,
          status: String(row[statusIdx] || ''),
        },
      }
    }
    if (calculation.packages <= 0) throw new Error('Суммы недостаточно для полного абонемента')
    var paymentId = nextId()
    var now = new Date().toISOString()
    if (categoryIdx !== -1) row[categoryIdx] = category
    if (frequencyIdx !== -1) row[frequencyIdx] = frequency
    if (amountIdx !== -1) row[amountIdx] = Number(row[amountIdx] || 0) + amount
    if (totalIdx !== -1) row[totalIdx] = Number(row[totalIdx] || 0) + calculation.lessonsAdded
    if (remainingIdx !== -1) row[remainingIdx] = Number(row[remainingIdx] || 0) + calculation.lessonsAdded
    if (paidIdx !== -1) row[paidIdx] = true
    if (balanceIdx !== -1) row[balanceIdx] = calculation.balance
    // An archived card is historical data. A late payment may be recorded,
    // but it must never reactivate the client and undo a concurrent archive.
    if (statusIdx !== -1 && String(row[statusIdx] || '') !== 'Архив') row[statusIdx] = 'Активен'

    paymentRowIndex = paymentSheet.getLastRow() + 1
    ledgerRowIndex = ledgerSheet.getLastRow() + 1
    writeChangedRowCells(clientContext.sheet, clientRowIndex + 1, previousRow, row)
    paymentSheet.appendRow([
      paymentId,
      safeValue(body.requestId),
      safeValue(body.clientId),
      safeValue(clientBranch),
      amount,
      safeValue(category),
      frequency,
      calculation.price,
      calculation.packageLessons,
      calculation.packages,
      calculation.lessonsAdded,
      now,
      safeValue(auth.username),
      safeValue(body.comment || ''),
      paymentFingerprint,
    ])
    appendLessonLedgerEntry(ledgerSheet, {
      requestId: body.requestId,
      clientId: body.clientId,
      branchId: clientBranch,
      paymentId: paymentId,
      type: 'purchase',
      lessonsDelta: calculation.lessonsAdded,
      totalLessonsDelta: calculation.lessonsAdded,
      balanceBefore: previousRow[remainingIdx],
      balanceAfter: row[remainingIdx],
      totalLessonsBefore: previousRow[totalIdx],
      totalLessonsAfter: row[totalIdx],
      createdAt: now,
      recordedBy: auth.username,
      comment: String(body.comment || ''),
      reason: 'Подтверждённый платёж',
      requestFingerprint: paymentFingerprint,
    })
    return {
      success: true,
      payment: {
        id: paymentId,
        clientId: String(body.clientId),
        amount: amount,
        category: category,
        lessonsPerWeek: frequency,
        packagePrice: calculation.price,
        packageLessons: calculation.packageLessons,
        packagesCount: calculation.packages,
        lessonsAdded: calculation.lessonsAdded,
        paidAt: now,
        comment: String(body.comment || ''),
      },
      client: {
        totalLessons: Number(row[totalIdx] || 0),
        remainingLessons: Number(row[remainingIdx] || 0),
        paidAmount: Number(row[amountIdx] || 0),
        paymentBalance: calculation.balance,
        category: category,
        lessonsPerWeek: frequency,
        status: String(row[statusIdx] || ''),
      },
    }
  } catch (error) {
    try {
      if (clientContext && clientRowIndex !== -1 && previousRow)
        writeChangedRowCells(clientContext.sheet, clientRowIndex + 1, row, previousRow)
      if (paymentSheet && paymentRowIndex >= paymentSheet.getLastRow()) paymentSheet.deleteRow(paymentRowIndex)
      if (ledgerSheet && ledgerRowIndex >= ledgerSheet.getLastRow()) ledgerSheet.deleteRow(ledgerRowIndex)
    } catch (rollbackError) {}
    throw error
  }
}

function getClientHistory(ss, body, auth) {
  var context = sheetContext(ss, 'Клиенты')
  var rowIndex = findRowById(context.data, context.idIdx, body.clientId)
  if (rowIndex === -1) throw new Error('Клиент не найден')
  var branchIdx = context.headers.indexOf('branchId')
  if (branchIdx !== -1 && !branchMatches(auth, context.data[rowIndex][branchIdx]))
    throw new Error('Доступ к филиалу запрещен')
  var payments = sheetObjects(requireExistingSheet(ss, 'Платежи'))
  var ledger = sheetObjects(requireExistingSheet(ss, 'Журнал занятий'))
  function toObjects(parsed) {
    var idIdx = parsed.headers.indexOf('clientId')
    return parsed.rows
      .filter(function (row) {
        return String(row[idIdx] || '') === String(body.clientId)
      })
      .map(function (row) {
        var object = {}
        parsed.headers.forEach(function (header, index) {
          if (header) object[header] = row[index]
        })
        return object
      })
      .reverse()
  }
  return { success: true, payments: toObjects(payments), ledger: toObjects(ledger) }
}

function getReceipt(ss, body, auth) {
  var context = sheetContext(ss, 'Клиенты')
  var rowIndex = findRowById(context.data, context.idIdx, body.clientId)
  if (rowIndex === -1) throw new Error('Клиент не найден')
  var branchIdx = context.headers.indexOf('branchId')
  var receiptIdx = context.headers.indexOf('receiptUrl')
  if (branchIdx !== -1 && !branchMatches(auth, context.data[rowIndex][branchIdx]))
    throw new Error('Доступ к филиалу запрещен')
  var reference = receiptIdx === -1 ? '' : String(context.data[rowIndex][receiptIdx] || '')
  if (!reference) throw new Error('Квитанция не найдена')
  if (reference.indexOf('drive:') !== 0) throw new Error('Старая квитанция требует повторной загрузки')
  var file = DriveApp.getFileById(reference.substring(6))
  var blob = file.getBlob()
  return {
    success: true,
    fileName: file.getName(),
    mimeType: blob.getContentType(),
    base64: Utilities.base64Encode(blob.getBytes()),
  }
}

// ==========================================
// 2. ОСНОВНОЙ ОБРАБОТЧИК (doPost)
// ==========================================
function doPost(e) {
  ACTIVE_IDEMPOTENCY_KEY = ''
  ACTIVE_IDEMPOTENCY_FINGERPRINT = ''
  ACTIVE_MUTATION_LOCK = false
  var mutationLock = null
  var requestStartedAt = new Date().getTime()
  if (!e || !e.postData || !e.postData.contents) return options()

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet()
    var body = JSON.parse(e.postData.contents)
    diagnosticLog('request.received', {
      hasSignedEnvelope: Boolean(body.signedEnvelope),
      hasSignature: Boolean(body.signature),
    })

    var scriptSecret = PropertiesService.getScriptProperties().getProperty('GAS_HMAC_SECRET')
    // The signed envelope is the only BFF-to-GAS trust mechanism.
    if (!scriptSecret || scriptSecret.length < 32) {
      diagnosticLog('request.rejected', { stage: 'hmac_secret' })
      return createResponse(apiErrorPayload('SCHEMA'))
    }
    body = verifySignedEnvelope(body, scriptSecret)
    diagnosticLog('signature.accepted', { action: String(body.action || '') })
    var schemaVersion = PropertiesService.getScriptProperties().getProperty('SCHEMA_VERSION')
    if (schemaVersion !== SCHEMA_VERSION) {
      diagnosticLog('request.rejected', { stage: 'schema', action: String(body.action || '') })
      return createResponse(apiErrorPayload('SCHEMA'))
    }

    // The BFF sends an envelope. Keep action/auth outside of the payload so a
    // browser cannot overwrite the server-provided authorization context.
    var envelope = body
    var payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {}
    body = {}
    Object.keys(payload).forEach(function (key) {
      body[key] = payload[key]
    })
    body.action = envelope.action
    body.auth = envelope.auth

    if (!isKnownAction(body.action)) throw new Error('Действие не найдено')
    validateRequest(body)

    // All CRM mutation actions use the same lock. Read their sheet snapshots only
    // after acquiring it, including authorization and idempotency checks.
    if (isMutatingAction(body.action)) {
      var lockStartedAt = new Date().getTime()
      var requestedLock = LockService.getScriptLock()
      if (!requestedLock.tryLock(20000)) throw new Error('Система занята, повторите операцию')
      mutationLock = requestedLock
      ACTIVE_MUTATION_LOCK = true
      diagnosticLog('mutation.lock_acquired', { waitMs: new Date().getTime() - lockStartedAt })
    }

    // Every mutating operation carries a request id. Keep a short-lived
    // response cache so retries cannot create a second row or spend lessons twice.
    // The cached response is returned only after fresh authorization succeeds.
    var cachedMutationResponse = null
    if (isMutatingAction(body.action) && body.action !== 'registerCoach') {
      var requestId = String(body.requestId || '')
      var actorId = body.auth && body.auth.id ? String(body.auth.id) : 'anonymous'
      var idempotencyKey = 'gas-idem:' + sha256(body.action + ':' + actorId + ':' + requestId)
      var idempotencyFingerprint = sha256(
        JSON.stringify({ action: body.action, payload: payload, auth: envelope.auth || null }),
      )
      var cachedIdempotency = CacheService.getScriptCache().get(idempotencyKey)
      if (cachedIdempotency) {
        try {
          var cachedRecord = JSON.parse(cachedIdempotency)
          if (cachedRecord.fingerprint !== idempotencyFingerprint)
            throw new Error('Этот requestId уже использован с другими данными')
          if (cachedRecord.response) cachedMutationResponse = cachedRecord.response
        } catch (cacheError) {
          if (cacheError.message === 'Этот requestId уже использован с другими данными') throw cacheError
        }
      }
      ACTIVE_IDEMPOTENCY_KEY = idempotencyKey
      ACTIVE_IDEMPOTENCY_FINGERPRINT = idempotencyFingerprint
    }

    var auth = null
    if (body.action !== 'getAuthUser' && body.action !== 'registerCoach') {
      var authorizationStartedAt = new Date().getTime()
      auth = requireServerAuth(body)
      diagnosticLog('authorization.checked', { action: String(body.action || ''), role: auth.role })
      assertGasPermission(body, auth)
      diagnosticLog('authorization.completed', { durationMs: new Date().getTime() - authorizationStartedAt })
    }

    if (cachedMutationResponse) {
      // Attendance retries must return CURRENT balances, not a five-minute-old
      // snapshot. Durable request markers below prevent a second deduction.
      if (body.action !== 'recordAttendance' && body.action !== 'recordBulkAttendance') {
        ACTIVE_MUTATION_LOCK = false
        return createResponse(cachedMutationResponse)
      }
    }

    // Public browser registration is mediated by the HMAC-authenticated BFF.
    // It can create only a pending coach, never an active user or administrator.
    if (body.action === 'registerCoach') {
      return createResponse(registerPendingCoachUser(ss, body))
    }

    // --- 1. АВТОРИЗАЦИЯ ---
    // This action is available only to the HMAC-authenticated BFF. It returns
    // a stored scrypt hash so password verification stays in Node, never GAS.
    if (body.action === 'getAuthUser') {
      var authUsersSheet = requireExistingSheet(ss, 'Users')
      var authUsersData = authUsersSheet.getDataRange().getValues()
      var authUsersHeaders = requireUsersAccessColumns(authUsersSheet)
      var authUsernameIdx = authUsersHeaders.indexOf('username')
      var authPasswordIdx = authUsersHeaders.indexOf('password')
      var authRoleIdx = authUsersHeaders.indexOf('role')
      var authBranchIdx = authUsersHeaders.indexOf('branchId')
      var authStatusIdx = authUsersHeaders.indexOf('status')
      var requestedUsername = String(body.username || '')
        .trim()
        .toLowerCase()
      var authUser = null
      for (var loginIndex = 1; loginIndex < authUsersData.length; loginIndex++) {
        if (
          String(authUsersData[loginIndex][authUsernameIdx] || '')
            .trim()
            .toLowerCase() === requestedUsername
        ) {
          authUser = {
            id: String(authUsersData[loginIndex][authUsersHeaders.indexOf('id')] || ''),
            username: String(authUsersData[loginIndex][authUsernameIdx] || '').trim(),
            passwordHash: String(authUsersData[loginIndex][authPasswordIdx] || ''),
            role: authUsersData[loginIndex][authRoleIdx] || '',
            branchId: authUsersData[loginIndex][authBranchIdx] || null,
            status: String(authUsersData[loginIndex][authStatusIdx] || ''),
          }
          break
        }
      }
      return createResponse({ user: authUser })
    }

    if (body.action === 'getUsers') {
      var usersSheet = requireExistingSheet(ss, 'Users')
      var usersData = usersSheet.getDataRange().getValues()
      var usersHeaders = requireUsersAccessColumns(usersSheet)
      var usersResult = usersData
        .slice(1)
        .map(function (row) {
          return {
            id: String(row[usersHeaders.indexOf('id')] || ''),
            username: String(row[usersHeaders.indexOf('username')] || ''),
            role: normalizeRole(row[usersHeaders.indexOf('role')]),
            branchId: String(row[usersHeaders.indexOf('branchId')] || '') || null,
            status: String(row[usersHeaders.indexOf('status')] || ''),
            disabledAt: String(row[usersHeaders.indexOf('disabledAt')] || '') || null,
            disabledBy: String(row[usersHeaders.indexOf('disabledBy')] || '') || null,
          }
        })
        .filter(function (user) {
          return user.id && user.role === 'coach'
        })
      return createResponse(usersResult)
    }

    if (body.action === 'assignUserBranch') {
      return createResponse(assignCoachUserBranch(ss, body, auth))
    }

    if (body.action === 'deactivateUser') {
      return createResponse(deactivateCoachUser(ss, body.userId, auth, body))
    }

    if (body.action === 'activateUser') {
      return createResponse(activateCoachUser(ss, body.userId, auth, body))
    }

    if (body.action === 'resetCoachPassword') {
      return createResponse(resetCoachPassword(ss, body.userId, body.passwordHash, auth, body))
    }

    if (body.action === 'linkCoachUser') {
      return createResponse(linkCoachUser(ss, body.coachId, body.userId, auth, body))
    }

    // requireServerAuth already resolved the authoritative row from Users.
    // Return that canonical account instead of reading the same sheet twice.
    if (body.action === 'getCurrentUser') {
      return createResponse({
        status: 'success',
        user: {
          id: auth.id,
          username: auth.username,
          role: auth.role === 'admin' ? '1' : '2',
          branchId: auth.branchId,
        },
      })
    }

    // --- 2. GET (getSheet) ---
    if (body.action === 'getClients') {
      return createResponse(getClientsPage(ss, auth, body))
    }

    if (body.action === 'getDashboardSummary') {
      return createResponse(getDashboardSummary(ss, auth, body))
    }

    if (body.action === 'getFinanceSummary') {
      return createResponse(getFinanceSummary(ss, auth, body))
    }

    if (body.action === 'getSubscriptionsPage') {
      return createResponse(getSubscriptionsPage(ss, auth, body))
    }

    if (body.action === 'getBootstrapData') {
      var bootstrapCacheVersion = readCacheVersion()
      return createResponse({
        branches: objectsForAuth(requireExistingSheet(ss, 'Филиалы'), auth, '', bootstrapCacheVersion),
        coaches: body.includeCoaches === false ? [] : objectsForAuth(
          requireExistingSheet(ss, 'Тренеры'),
          auth,
          body.branchId,
          bootstrapCacheVersion,
        ),
        lessons: objectsForAuth(
          requireExistingSheet(ss, 'Расписание'),
          auth,
          body.branchId,
          bootstrapCacheVersion,
        ),
      })
    }

    if (body.action === 'searchClientOptions') {
      return createResponse(searchClientOptions(ss, auth, body))
    }

    if (body.action === 'getLessonRoster') {
      return createResponse(getLessonRoster(ss, body, auth))
    }

    if (body.action === 'getSheet') {
      var ALLOWED_SHEETS = ['Клиенты', 'Филиалы', 'Тренеры', 'Расписание']
      if (ALLOWED_SHEETS.indexOf(body.sheet) === -1) throw new Error('Доступ запрещен')

      var sheet = ss.getSheetByName(body.sheet)
      if (!sheet) throw new Error('Лист не найден')
      return createResponse(objectsForAuth(sheet, auth, body.branchId))
    }

    // --- 3. БИЗНЕС-ЛОГИКА ---
    var actionToSheet = {
      recordBulkAttendance: 'Клиенты',
      uploadReceipt: 'Клиенты',
      updateClient: 'Клиенты',
      updateLesson: 'Расписание',
      deleteClient: 'Клиенты',
      deleteCoach: 'Тренеры',
      deleteLesson: 'Расписание',
      createClient: 'Клиенты',
      createBranch: 'Филиалы',
      createCoach: 'Тренеры',
      createLesson: 'Расписание',
    }

    if (['createClient', 'createLesson', 'createCoach'].indexOf(body.action) !== -1) {
      assertScopedBranch(body, auth, ss)
    }

    // Attendance is serialized to prevent two coaches from spending the same
    // lesson simultaneously. requestId makes retries safe and corrections are
    // applied as a delta (attended <-> absent), never as another charge.
    if (body.action === 'recordAttendance' || body.action === 'recordBulkAttendance') {
      var attendanceList =
        body.action === 'recordAttendance'
          ? [
              {
                clientId: body.clientId,
                status: body.status,
                isWalkin: false,
                date: body.date,
                lessonId: body.lessonId,
                requestId: body.requestId,
              },
            ]
          : body.attendance.map(function (entry) {
              var copy = {}
              Object.keys(entry).forEach(function (key) { copy[key] = entry[key] })
              return copy
            })
      var attendanceReadStartedAt = new Date().getTime()
      var lessonBatch = sheetObjects(requireExistingSheet(ss, 'Расписание'))
      lessonBatch.occurrences = Object.create(null)
      var clientBatchContext = sheetContext(ss, 'Клиенты')
      requireClientSubscriptionHeaders(clientBatchContext.headers)
      var clientBatch = {
        sheet: clientBatchContext.sheet,
        headers: clientBatchContext.headers,
        data: clientBatchContext.data,
        rowById: Object.create(null),
      }
      clientBatch.data.forEach(function (row, index) {
        if (!index) return
        var key = String(row[clientBatchContext.idIdx] || '').trim()
        if (clientBatch.rowById[key] === undefined) clientBatch.rowById[key] = index
      })
      var attendanceLedgerSheet = requireExistingSheet(ss, 'Журнал занятий')
      var attendanceLedger = sheetObjects(attendanceLedgerSheet)
      requireLessonLedgerHeaders(attendanceLedger.headers)
      var attendancePayments = sheetObjects(requireExistingSheet(ss, 'Платежи'))
      var selectedAccountingClients = Object.create(null)
      var selectedAttendanceRequests = Object.create(null)
      attendanceList.forEach(function (item) {
        var clientId = String(item.clientId)
        selectedAccountingClients[clientId] = true
        selectedAttendanceRequests[String(item.requestId || body.requestId) + ':' + clientId] = true
      })
      var ledgerByClient = accountingRowsByClient(attendanceLedger, selectedAccountingClients)
      var paymentsByClient = accountingRowsByClient(attendancePayments, selectedAccountingClients)
      var requestColumn = attendanceLedger.headers.indexOf('requestId')
      var attendanceRequests = Object.create(null)
      attendanceLedger.rows.forEach(function (row, index) {
        var key = String(row[requestColumn] || '')
        if (!selectedAttendanceRequests[key]) return
        if (!attendanceRequests[key]) attendanceRequests[key] = { row: row, index: index }
      })
      diagnosticLog('attendance.snapshot_loaded', {
        durationMs: new Date().getTime() - attendanceReadStartedAt,
        marks: attendanceList.length,
      })
      var attendanceValidationStartedAt = new Date().getTime()
      var checkedAccountingClients = Object.create(null)
      var originalAttendanceValues = {}
      var legacyLedgerEntries = []
      var attendanceLedgerEntries = []
      var dirtyClientRows = {}
      var results = attendanceList.map(function (item) {
        try {
          var requestId = item.requestId || body.requestId
          if (!requestId) throw new Error('Не указан idempotency key')
          item.requestId = String(requestId) + ':' + String(item.clientId)
          var context = validateAttendanceItem(item, ss, auth, clientBatch, lessonBatch)
          var clientId = String(item.clientId)
          var attendanceFingerprint = sha256(JSON.stringify({
            actorId: String(auth.id), clientId: clientId, lessonId: String(item.lessonId),
            date: String(item.date), status: String(item.status),
          }))
          var previousRequest = attendanceRequests[item.requestId]
          if (previousRequest) {
            if (String(previousRequest.row[attendanceLedger.headers.indexOf('requestFingerprint')] || '') !== attendanceFingerprint)
              throw new Error('Этот requestId уже использован с другими данными')
            return { success: true, duplicate: true, clientId: clientId }
          }
          if (!checkedAccountingClients[clientId]) {
            var clientLedger = accountingClientRows(ledgerByClient, attendanceLedger.headers, clientId)
            var clientPayments = accountingClientRows(paymentsByClient, attendancePayments.headers, clientId)
            var reconciliation = clientLedgerReconciliation(
              context.clientData[context.clientRowIndex], context.clientHeaders, clientLedger, clientPayments, clientId,
            )
            var preparedBaseline = prepareLegacyLedgerBaseline(
                clientLedger,
                clientPayments,
                context.clientData[context.clientRowIndex],
                context.clientHeaders,
                clientId,
                auth,
                reconciliation,
              )
            legacyLedgerEntries = legacyLedgerEntries.concat(preparedBaseline)
            assertClientLedgerReconciled(
              context.clientData[context.clientRowIndex],
              context.clientHeaders,
              clientLedger,
              clientPayments,
              clientId,
              preparedBaseline.length ? null : reconciliation,
            )
            checkedAccountingClients[clientId] = true
          }
          if (!originalAttendanceValues[context.clientRowIndex]) {
            originalAttendanceValues[context.clientRowIndex] = {}
            ;['remainingLessons', 'attendanceHistory', 'status'].forEach(function (header) {
              var index = context.clientHeaders.indexOf(header)
              originalAttendanceValues[context.clientRowIndex][header] =
                index === -1 ? undefined : context.clientData[context.clientRowIndex][index]
            })
          }
          var result = processClientAttendance(item, context, auth)
          if (!result.duplicate) dirtyClientRows[context.clientRowIndex] = true
          // Record EVERY confirmed request, including absences and unchanged
          // marks. Zero-delta markers make retries durable after cache expiry,
          // without undoing a newer correction or spending another credit.
          if (!result.ledgerEntry) {
            var attendanceRow = context.clientData[context.clientRowIndex]
            var currentBalance = Number(attendanceRow[context.clientHeaders.indexOf('remainingLessons')] || 0)
            var currentTotal = Number(attendanceRow[context.clientHeaders.indexOf('totalLessons')] || 0)
            result.ledgerEntry = {
              requestId: item.requestId, clientId: clientId, branchId: context.lessonBranch,
              type: 'attendance_confirmation', lessonsDelta: 0, totalLessonsDelta: 0,
              balanceBefore: currentBalance, balanceAfter: currentBalance,
              totalLessonsBefore: currentTotal, totalLessonsAfter: currentTotal,
              recordedBy: auth.username, comment: 'Занятие ' + String(item.lessonId) + ' · ' + String(item.date),
              reason: 'Подтверждение отметки посещения',
            }
          }
          result.ledgerEntry.requestFingerprint = attendanceFingerprint
          attendanceLedgerEntries.push(result.ledgerEntry)
          var confirmedRequestRow = lessonLedgerRow(attendanceLedger.headers, result.ledgerEntry)
          attendanceRequests[item.requestId] = { row: confirmedRequestRow }
          delete result.ledgerEntry
          result.clientId = clientId
          return result
        } catch (error) {
          var attendanceError = apiErrorPayload(error)
          return {
            clientId: item.clientId || null,
            success: false,
            code: attendanceError.code,
            message: attendanceError.message,
          }
        }
      })
      var attendanceSuccess = results.every(function (result) {
        return result.success
      })
      diagnosticLog('attendance.validated', {
        durationMs: new Date().getTime() - attendanceValidationStartedAt,
        success: attendanceSuccess,
      })
      var attendanceFailure = null
      if (!attendanceSuccess) {
        attendanceFailure = results.filter(function (result) {
          return !result.success
        })[0]
        return createResponse({
          status: 'error',
          success: false,
          code: attendanceFailure.code,
          message: attendanceFailure.message,
          results: results,
        })
      }

      // Validate the whole chunk before writing. SpreadsheetApp has no
      // multi-sheet transaction: include both client and ledger writes in the
      // rollback scope, and retain row indices even if a write throws late.
      var appendedLedgerRows = []
      var attendanceWriteStartedAt = new Date().getTime()
      var allAttendanceEntries = legacyLedgerEntries.concat(attendanceLedgerEntries)
      var atomicAttendance = PropertiesService.getScriptProperties().getProperty('ATTENDANCE_ATOMIC_WRITES') === 'true'
      if (atomicAttendance) {
        writeAttendanceAtomic(ss, clientBatch, dirtyClientRows, attendanceLedgerSheet, attendanceLedger.headers, allAttendanceEntries)
      } else {
        try {
          writeAttendanceChanges(clientBatch, dirtyClientRows)
          var firstAttendanceLedgerRow = attendanceLedgerSheet.getLastRow() + 1
          appendedLedgerRows = allAttendanceEntries.map(function (_entry, index) { return firstAttendanceLedgerRow + index })
          appendLessonLedgerEntries(
            attendanceLedgerSheet,
            attendanceLedger.headers,
            allAttendanceEntries,
            firstAttendanceLedgerRow,
          )
        } catch (ledgerError) {
          var attendanceRollbackFailed = false
          ;['remainingLessons', 'attendanceHistory', 'status'].forEach(function (header) {
            var column = clientBatch.headers.indexOf(header)
            if (column === -1) return
            Object.keys(originalAttendanceValues).forEach(function (index) {
              try {
                clientBatch.sheet.getRange(Number(index) + 1, column + 1).setValue(originalAttendanceValues[index][header])
              } catch (rollbackError) { attendanceRollbackFailed = true }
            })
          })
          appendedLedgerRows
            .sort(function (left, right) {
              return right - left
            })
            .forEach(function (rowIndex) {
              try {
                if (attendanceLedgerSheet.getLastRow() >= rowIndex) attendanceLedgerSheet.deleteRow(rowIndex)
              } catch (rollbackError) { attendanceRollbackFailed = true }
            })
          if (attendanceRollbackFailed) diagnosticLog('attendance.rollback_failed', { action: String(body.action) })
          throw ledgerError
        }
      }
      diagnosticLog('attendance.written', { durationMs: new Date().getTime() - attendanceWriteStartedAt })
      results.forEach(function (result) {
        var clientRow = clientBatch.data[clientBatch.rowById[String(result.clientId).trim()]]
        result.client = {
          remainingLessons: Number(clientRow[clientBatch.headers.indexOf('remainingLessons')] || 0),
          totalLessons: Number(clientRow[clientBatch.headers.indexOf('totalLessons')] || 0),
          status: String(clientRow[clientBatch.headers.indexOf('status')] || ''),
        }
      })
      return createResponse({
        status: 'success',
        success: true,
        results: results,
      })
    }

    if (body.action === 'recordPayment') {
      return createResponse(recordPayment(ss, body, auth))
    }

    if (body.action === 'recordAdjustment') {
      return createResponse(recordAdjustment(ss, body, auth))
    }

    if (body.action === 'auditLessonLedger') {
      return createResponse(auditLessonLedger(ss, body, auth))
    }

    if (body.action === 'repairLessonLedger') {
      return createResponse(repairLessonLedger(ss, body, auth))
    }

    if (body.action === 'getClientHistory') {
      return createResponse(getClientHistory(ss, body, auth))
    }

    if (body.action === 'uploadReceipt') {
      return createResponse(uploadReceipt(ss, body))
    }

    if (body.action === 'getReceipt') {
      return createResponse(getReceipt(ss, body, auth))
    }

    if (body.action === 'createCoach') {
      return createResponse(createCoachWithOptionalAccount(ss, body))
    }

    if (body.action === 'assignClientLesson') {
      return createResponse(assignClientLesson(ss, body, auth))
    }

    if (body.action.indexOf('update') === 0) {
      return createResponse(updateEntity(ss, actionToSheet, body, auth))
    }

    if (body.action.indexOf('delete') === 0) {
      return createResponse(deleteEntity(ss, actionToSheet, body, auth))
    }

    if (body.action === 'createClient') {
      var initialClientBody = {}
      Object.keys(body).forEach(function (key) {
        initialClientBody[key] = body[key]
      })
      initialClientBody.paidAmount = 0
      var clientContext = sheetContext(ss, 'Клиенты')
      var createdClient = appendClientObject(clientContext, initialClientBody)
      try {
        if (Number(body.paidAmount || 0) > 0) {
          var initialPaymentBody = {}
          Object.keys(body).forEach(function (key) {
            initialPaymentBody[key] = body[key]
          })
          initialPaymentBody.clientId = String(createdClient.id)
          initialPaymentBody.amount = Number(body.paidAmount)
          initialPaymentBody.requestId = String(body.requestId) + ':initial-payment'
          var initialPayment = recordPayment(ss, initialPaymentBody, auth)
          createdClient.totalLessons = initialPayment.client.totalLessons
          createdClient.remainingLessons = initialPayment.client.remainingLessons
          createdClient.paidAmount = initialPayment.client.paidAmount
          createdClient.paymentBalance = initialPayment.client.paymentBalance
        }
        return createResponse(createdClient)
      } catch (creationError) {
        var createdData = clientContext.sheet.getDataRange().getValues()
        var createdRowIndex = findRowById(createdData, clientContext.idIdx, createdClient.id)
        if (createdRowIndex !== -1) clientContext.sheet.deleteRow(createdRowIndex + 1)
        throw creationError
      }
    }

    if (body.action === 'createLesson') {
      return createResponse(createLessonWithOptionalClient(ss, body, auth))
    }

    if (body.action.indexOf('create') === 0) {
      return createResponse(appendObject(sheetContext(ss, actionToSheet[body.action]), body))
    }

    return createResponse(apiErrorPayload('VALIDATION'))
  } catch (err) {
    var normalizedError = apiErrorPayload(err)
    diagnosticLog('request.failed', {
      action: body && body.action ? String(body.action) : '',
      code: normalizedError.code,
      authStage: err && err.authStage ? String(err.authStage) : '',
    })
    return createResponse(normalizedError)
  } finally {
    if (mutationLock) {
      // createResponse() already flushes successful and failed mutations before
      // serializing the response. A second flush here only adds latency.
      mutationLock.releaseLock()
      ACTIVE_MUTATION_LOCK = false
    }
    diagnosticLog('request.finished', {
      action: body && isKnownAction(body.action) ? String(body.action) : 'unknown',
      durationMs: new Date().getTime() - requestStartedAt,
    })
  }
}
