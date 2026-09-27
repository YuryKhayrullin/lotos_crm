function createResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function options() {
  return createResponse({ status: 'error', message: 'Unauthorized' });
}

// GET is intentionally disabled. All data access must pass through the
// authenticated Next.js BFF and the signed GAS request contract.
function doGet() {
  return createResponse({ status: 'error', message: 'Unauthorized' });
}

function safeValue(val) {
  if (val === undefined || val === null) return '';
  var str = String(val).trim();
  // Google Sheets treats values beginning with these characters as formulas.
  if (/^[=+\-@]/.test(str) || /^[\t\r\n]/.test(str)) return "'" + str;
  return str;
}

function sha256(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b < 0) b += 256;
    var h = b.toString(16);
    if (h.length === 1) h = '0' + h;
    hex += h;
  }
  return hex;
}

function hmacSha256(str, salt) {
  var bytes = Utilities.computeHmacSha256Signature(str, salt);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b < 0) b += 256;
    var h = b.toString(16);
    if (h.length === 1) h = '0' + h;
    hex += h;
  }
  return hex;
}

function securePasswordHash(password) {
  var salt = Utilities.getUuid().replace(/-/g, '');
  return 'v2$' + salt + '$' + hmacSha256(String(password), salt);
}

function passwordsMatch(password, stored) {
  var value = String(stored || '');
  if (value.indexOf('v2$') === 0) {
    var parts = value.split('$');
    if (parts.length !== 3) return false;
    var expected = hmacSha256(String(password), parts[1]);
    if (expected.length !== parts[2].length) return false;
    var difference = 0;
    for (var i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
    return difference === 0;
  }
  return sha256(String(password)) === value;
}

function getHeaders(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

function getOrCreateUsersSheet(ss) {
  var sheet = ss.getSheetByName('Users');
  if (!sheet) {
    sheet = ss.insertSheet('Users');
    sheet.appendRow(['id', 'username', 'password', 'role', 'branchId']);
  }
  return sheet;
}

function requireText(body, field, maxLength) {
  var value = body[field];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error('Поле обязательно: ' + field);
  }
  if (maxLength && String(value).length > maxLength) {
    throw new Error('Слишком длинное поле: ' + field);
  }
}

function requireId(body) {
  requireText(body, 'id', 100);
}

function requireNonNegativeNumber(body, field) {
  if (body[field] === undefined || body[field] === null || String(body[field]).trim() === '') return;
  var value = Number(body[field]);
  if (!isFinite(value) || value < 0) throw new Error('Некорректное числовое поле: ' + field);
}

function validateRequest(body) {
  if (!body || !body.action || typeof body.action !== 'string') {
    throw new Error('Не указано действие');
  }

  if (body.action === 'login') {
    requireText(body, 'username', 100);
    requireText(body, 'password', 200);
  } else if (body.action === 'register') {
    requireText(body, 'username', 100);
    requireText(body, 'password', 200);
  } else if (body.action === 'createUser') {
    requireText(body, 'username', 100);
    requireText(body, 'password', 200);
    requireText(body, 'role', 20);
    if (['admin', 'coach'].indexOf(String(body.role).toLowerCase()) === -1) throw new Error('Недопустимая роль');
  } else if (body.action === 'getUsers') {
    // No payload fields.
  } else if (body.action === 'assignUserBranch') {
    requireText(body, 'userId', 100);
    requireText(body, 'branchId', 100);
  } else if (body.action === 'getSheet') {
    if (['Клиенты', 'Филиалы', 'Тренеры', 'Расписание'].indexOf(body.sheet) === -1) {
      throw new Error('Недопустимый лист');
    }
  } else if (body.action === 'getClients') {
    if (body.page !== undefined && (!isFinite(Number(body.page)) || Number(body.page) < 1)) throw new Error('Некорректная страница');
    if (body.pageSize !== undefined && (!isFinite(Number(body.pageSize)) || Number(body.pageSize) < 1 || Number(body.pageSize) > 500)) throw new Error('Некорректный размер страницы');
  } else if (body.action === 'createClient') {
    requireText(body, 'childName', 150);
    requireText(body, 'parentName', 150);
    requireText(body, 'branchId', 100);
    if (body.lessonsPerWeek !== undefined && [1, 2, 3].indexOf(Number(body.lessonsPerWeek)) === -1) throw new Error('Некорректная нагрузка');
    requireNonNegativeNumber(body, 'paidAmount');
    if (body.category && ['плавание', 'синхронное плавание'].indexOf(body.category) === -1) {
      throw new Error('Недопустимая категория клиента');
    }
  } else if (body.action === 'createLesson') {
    requireText(body, 'branchId', 100);
    requireText(body, 'date', 40);
    requireText(body, 'time', 40);
    requireText(body, 'title', 150);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) throw new Error('Дата занятия должна быть в ISO-формате');
    if (!/^\d{1,2}:\d{2}$/.test(String(body.time))) throw new Error('Время занятия должно быть в формате HH:mm');
  } else if (body.action === 'createBranch') {
    requireText(body, 'name', 150);
    requireText(body, 'address', 300);
  } else if (body.action === 'createCoach') {
    requireText(body, 'name', 150);
    requireText(body, 'branchId', 100);
  } else if (body.action === 'updateClient') {
    requireId(body);
    requireNonNegativeNumber(body, 'paidAmount');
  } else if (body.action.indexOf('update') === 0 || body.action.indexOf('delete') === 0) {
    requireId(body);
  } else if (body.action === 'recordAttendance') {
    if (body.isWalkin === true && !body.clientId) requireText(body, 'visitorName', 150);
    else requireText(body, 'clientId', 100);
    requireText(body, 'lessonId', 100);
    requireText(body, 'date', 40);
    requireText(body, 'requestId', 150);
    if (['attended', 'absent'].indexOf(body.status) === -1) throw new Error('Недопустимый статус посещения');
  } else if (body.action === 'recordBulkAttendance') {
    if (!Array.isArray(body.attendance) || body.attendance.length === 0) throw new Error('Пустой список посещаемости');
    if (body.attendance.length > 100) throw new Error('Слишком много отметок за один запрос');
    requireText(body, 'requestId', 150);
    body.attendance.forEach(function(item) {
      if (item.isWalkin === true && !item.clientId) requireText(item, 'visitorName', 150);
      else requireText(item, 'clientId', 100);
      requireText(item, 'lessonId', 100);
      requireText(item, 'date', 40);
      if (['attended', 'absent'].indexOf(item.status) === -1) throw new Error('Недопустимый статус посещения');
    });
  } else if (body.action === 'uploadReceipt') {
    requireText(body, 'clientId', 100);
    if (Number(body.lessonsCount) < 0 || isNaN(Number(body.lessonsCount))) throw new Error('Некорректное количество занятий');
    if (body.fileBase64 && !body.fileName) throw new Error('Не указано имя файла');
  } else if (body.action === 'getReceipt') {
    requireText(body, 'clientId', 100);
  } else if (body.action === 'addLessons') {
    requireText(body, 'clientId', 100);
    if (Number(body.lessonsCount) <= 0 || Number(body.lessonsCount) > 100 || isNaN(Number(body.lessonsCount))) throw new Error('Некорректное количество занятий');
  }
}

function isKnownAction(action) {
  return ['login', 'register', 'createUser', 'getUsers', 'assignUserBranch', 'getSheet', 'getClients', 'createClient', 'createLesson', 'createBranch', 'createCoach', 'updateClient', 'updateCoach', 'updateLesson', 'deleteClient', 'deleteCoach', 'deleteLesson', 'recordAttendance', 'recordBulkAttendance', 'uploadReceipt', 'getReceipt', 'addLessons'].indexOf(action) !== -1;
}

function nextId() {
  return String(new Date().getTime()) + '-' + String(Math.floor(Math.random() * 100000));
}

var SCHEMA_VERSION = '2';

function setupSchema() {
  // Run once from the Apps Script editor after deploying a new schema.
  PropertiesService.getScriptProperties().setProperty('SCHEMA_VERSION', SCHEMA_VERSION);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  getOrCreateUsersSheet(ss);
  var clients = ss.getSheetByName('Клиенты');
  if (clients) ensureClientSubscriptionColumns(clients);
  getOrCreateAttendanceSheet(ss);
  return 'Schema ' + SCHEMA_VERSION + ' is ready';
}

// Run once manually from the Apps Script editor to bootstrap the first admin.
// Before running, set BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD
// in Script Properties. They are deleted immediately after a successful run.
function setupInitialAdmin() {
  var properties = PropertiesService.getScriptProperties();
  var username = String(properties.getProperty('BOOTSTRAP_ADMIN_USERNAME') || '').trim();
  var password = String(properties.getProperty('BOOTSTRAP_ADMIN_PASSWORD') || '');
  if (!username || username.length > 100) throw new Error('Некорректный логин');
  if (password.length < 8 || password.length > 200) throw new Error('Пароль должен содержать от 8 до 200 символов');

  var sheet = getOrCreateUsersSheet(SpreadsheetApp.getActiveSpreadsheet());
  var headers = getHeaders(sheet);
  var data = sheet.getDataRange().getValues();
  var usernameIdx = headers.indexOf('username');
  if (data.slice(1).some(function(row) { return String(row[usernameIdx] || '').trim().toLowerCase() === username.toLowerCase(); })) {
    throw new Error('Пользователь с таким логином уже существует');
  }
  var row = headers.map(function(header) {
    if (header === 'id') return nextId();
    if (header === 'username') return safeValue(username);
    if (header === 'password') return securePasswordHash(password);
    if (header === 'role') return '1';
    if (header === 'branchId') return '';
    return '';
  });
  sheet.appendRow(row);
  properties.deleteProperty('BOOTSTRAP_ADMIN_USERNAME');
  properties.deleteProperty('BOOTSTRAP_ADMIN_PASSWORD');
  return 'Администратор создан: ' + username;
}

function getOrCreateAttendanceSheet(ss) {
  var sheet = ss.getSheetByName('Посещения');
  if (!sheet) {
    sheet = ss.insertSheet('Посещения');
    sheet.appendRow(['id', 'requestId', 'lessonId', 'date', 'clientId', 'visitorName', 'status', 'isWalkin', 'branchId', 'recordedBy', 'createdAt']);
  }
  return sheet;
}

function normalizeRole(value) {
  var role = String(value || '').toLowerCase();
  if (role === '1' || role === 'admin') return 'admin';
  if (role === '2' || role === 'coach') return 'coach';
  return '';
}

function requireServerAuth(body) {
  var auth = body && body.auth;
  if (!auth || typeof auth !== 'object') throw new Error('Unauthorized');
  var role = normalizeRole(auth.role);
  if (!role || !auth.id || !auth.username) throw new Error('Unauthorized');
  return {
    id: String(auth.id),
    username: String(auth.username),
    role: role,
    branchId: auth.branchId === undefined || auth.branchId === null || auth.branchId === '' ? null : String(auth.branchId)
  };
}

function isAdminAction(action) {
  return ['createUser', 'getUsers', 'assignUserBranch', 'createBranch', 'createCoach', 'updateCoach', 'deleteCoach', 'uploadReceipt', 'getReceipt', 'addLessons', 'createClient', 'updateClient', 'deleteClient'].indexOf(action) !== -1;
}

function assertGasPermission(body, auth) {
  var action = body.action;
  if (isAdminAction(action) && auth.role !== 'admin') throw new Error('Недостаточно прав');
  if (auth.role === 'coach' && ['getSheet', 'getClients', 'createLesson', 'updateLesson', 'deleteLesson', 'recordAttendance', 'recordBulkAttendance'].indexOf(action) === -1) {
    throw new Error('Недостаточно прав');
  }
  if (auth.role === 'coach' && !auth.branchId) throw new Error('У пользователя не назначен филиал');
}

function branchMatches(auth, branchId) {
  if (!auth || auth.role === 'admin') return true;
  return String(branchId || '') === String(auth.branchId || '');
}

function findHeader(headers, name) {
  return headers.indexOf(name);
}

function sheetObjects(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length <= 1) return { headers: values.length ? values[0] : [], rows: [] };
  var headers = values[0];
  return { headers: headers, rows: values.slice(1) };
}

function readCacheVersion() {
  return PropertiesService.getScriptProperties().getProperty('READ_CACHE_VERSION') || '1';
}

function invalidateReadCache() {
  PropertiesService.getScriptProperties().setProperty('READ_CACHE_VERSION', String(new Date().getTime()));
}

function objectsForAuth(sheet, auth, requestedBranchId) {
  var branchKey = auth.role === 'coach' ? String(auth.branchId || '') : String(requestedBranchId || 'all');
  var cacheKey = 'crm:' + readCacheVersion() + ':' + sheet.getName() + ':' + auth.role + ':' + branchKey;
  var cache = CacheService.getScriptCache();
  try {
    var cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (error) {}
  var parsed = sheetObjects(sheet);
  var branchIdx = parsed.headers.indexOf('branchId');
  var branchId = auth.role === 'coach' ? auth.branchId : (requestedBranchId || '');
  var idIdx = parsed.headers.indexOf('id');
  var result = parsed.rows.filter(function(row) {
    if (sheet.getName() === 'Филиалы' && auth.role === 'coach') {
      return String(row[idIdx] || '') === String(auth.branchId || '');
    }
    if (!branchId || branchIdx === -1) return true;
    return String(row[branchIdx] || '') === String(branchId);
  }).map(function(row) {
    var obj = {};
    parsed.headers.forEach(function(header, index) { if (header) obj[header] = row[index]; });
    return obj;
  });
  try { cache.put(cacheKey, JSON.stringify(result), 60); } catch (error) {}
  return result;
}

function getClientsPage(ss, auth, body) {
  var sheet = ss.getSheetByName('Клиенты');
  if (!sheet) throw new Error('Лист клиентов не найден');
  var items = objectsForAuth(sheet, auth, body.branchId);
  var query = String(body.query || '').trim().toLowerCase();
  var status = String(body.status || '').trim();
  if (query) {
    items = items.filter(function(item) {
      return [item.childName, item.parentName, item.phone, item.email].some(function(value) {
        return String(value || '').toLowerCase().indexOf(query) !== -1;
      });
    });
  }
  if (status && ['Активен', 'Пауза', 'Архив'].indexOf(status) !== -1) {
    items = items.filter(function(item) { return String(item.status || '') === status; });
  }
  var page = Math.max(1, Number(body.page || 1));
  var pageSize = Math.min(500, Math.max(1, Number(body.pageSize || 100)));
  var start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page: page,
    pageSize: pageSize,
    hasMore: start + pageSize < items.length
  };
}

function assertBranchExists(ss, branchId) {
  if (!branchId) throw new Error('Не указан филиал');
  var sheet = ss.getSheetByName('Филиалы');
  if (!sheet) throw new Error('Лист филиалов не найден');
  var parsed = sheetObjects(sheet);
  var idIdx = parsed.headers.indexOf('id');
  var found = parsed.rows.some(function(row) { return String(row[idIdx]) === String(branchId); });
  if (!found) throw new Error('Филиал не найден');
}

function singleBranchId(ss) {
  var sheet = ss.getSheetByName('Филиалы');
  if (!sheet) throw new Error('Лист филиалов не найден');
  var parsed = sheetObjects(sheet);
  var idIdx = parsed.headers.indexOf('id');
  var ids = parsed.rows.map(function(row) { return String(row[idIdx] || '').trim(); }).filter(Boolean);
  if (ids.length !== 1) throw new Error('Выберите филиал: найдено филиалов ' + ids.length);
  return ids[0];
}

function resolveBranchId(ss, branchId) {
  var resolved = String(branchId || '').trim() || singleBranchId(ss);
  assertBranchExists(ss, resolved);
  return resolved;
}

function assertScopedBranch(body, auth, ss) {
  if (body.branchId) {
    if (!branchMatches(auth, body.branchId)) throw new Error('Доступ к филиалу запрещен');
    assertBranchExists(ss, body.branchId);
  } else if (auth.role === 'coach') {
    body.branchId = auth.branchId;
  } else {
    body.branchId = singleBranchId(ss);
  }
}

function revokeReceiptAccess(reference) {
  var value = String(reference || '');
  var fileId = value.indexOf('drive:') === 0 ? value.substring(6) : (value.match(/[-\w]{25,}/) || [])[0];
  if (!fileId) return;
  try {
    DriveApp.getFileById(fileId).setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  } catch (error) {}
}

function packageLessonsFromFrequency(lessonsPerWeek) {
  var frequency = Number(lessonsPerWeek);
  if ([1, 2, 3].indexOf(frequency) === -1) return 0;
  return frequency * 4;
}

function parseHistory(value) {
  try {
    var parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) { return []; }
}

function findRowById(data, idIdx, id) {
  for (var i = 1; i < data.length; i++) if (String(data[i][idIdx]) === String(id)) return i;
  return -1;
}

function validateAttendanceItem(item, ss, auth, sharedClients) {
  if (!item || !item.lessonId || !item.date || !item.status) throw new Error('Некорректная отметка посещения');
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(String(item.date))) throw new Error('Дата должна быть в ISO-формате');
  if (['attended', 'absent'].indexOf(item.status) === -1) throw new Error('Недопустимый статус посещения');
  if (!item.requestId) throw new Error('Не указан idempotency key');
  var lessonSheet = ss.getSheetByName('Расписание');
  if (!lessonSheet) throw new Error('Лист расписания не найден');
  var lesson = sheetObjects(lessonSheet);
  var lessonIdIdx = lesson.headers.indexOf('id');
  var branchIdx = lesson.headers.indexOf('branchId');
  var lessonRow = lesson.rows.findIndex(function(row) { return String(row[lessonIdIdx]) === String(item.lessonId); });
  if (lessonRow === -1) throw new Error('Занятие не найдено');
  var lessonBranch = branchIdx === -1 ? '' : lesson.rows[lessonRow][branchIdx];
  if (!branchMatches(auth, lessonBranch)) throw new Error('Доступ к филиалу запрещен');
  if (!item.clientId) {
    if (item.isWalkin !== true || !item.visitorName) throw new Error('Для walk-in укажите имя посетителя');
    return { lessonBranch: String(lessonBranch), clientRowIndex: -1, clientSheet: null };
  }
  var clientSheet = sharedClients ? sharedClients.sheet : ss.getSheetByName('Клиенты');
  if (!clientSheet) throw new Error('Лист клиентов не найден');
  var headers = sharedClients ? sharedClients.headers : ensureClientSubscriptionColumns(clientSheet);
  var data = sharedClients ? sharedClients.data : clientSheet.getDataRange().getValues();
  var idIdx = headers.indexOf('id');
  var clientBranchIdx = headers.indexOf('branchId');
  var clientRow = findRowById(data, idIdx, item.clientId);
  if (clientRow === -1) throw new Error('Клиент не найден');
  var clientBranch = clientBranchIdx === -1 ? '' : data[clientRow][clientBranchIdx];
  if (!branchMatches(auth, clientBranch) || String(clientBranch) !== String(lessonBranch)) throw new Error('Клиент и занятие находятся в разных филиалах');
  var assignedIdx = headers.indexOf('assignedLessonIds');
  var legacyAssignedIdx = headers.indexOf('assignedLessonId');
  var assignedValue = assignedIdx !== -1 ? data[clientRow][assignedIdx] : '';
  if (!assignedValue && legacyAssignedIdx !== -1) assignedValue = data[clientRow][legacyAssignedIdx];
  if (!assignedValue || String(assignedValue).split(',').map(function(value) { return value.trim(); }).indexOf(String(item.lessonId)) === -1) {
    throw new Error('Клиент не записан на это занятие');
  }
  var remainingIdx = headers.indexOf('remainingLessons');
  if (item.status === 'attended' && item.isWalkin !== true && remainingIdx !== -1 && Number(data[clientRow][remainingIdx] || 0) <= 0) {
    throw new Error('У клиента закончились занятия');
  }
  return { lessonBranch: String(lessonBranch), clientRowIndex: clientRow, clientSheet: clientSheet, clientHeaders: headers, clientData: data };
}

function processWalkinAttendance(item, ss, auth, lessonBranch) {
  var sheet = getOrCreateAttendanceSheet(ss), parsed = sheetObjects(sheet), headers = parsed.headers;
  var requestIdx = headers.indexOf('requestId'), lessonIdx = headers.indexOf('lessonId');
  var dateIdx = headers.indexOf('date'), visitorIdx = headers.indexOf('visitorName'), statusIdx = headers.indexOf('status');
  var existing = parsed.rows.findIndex(function(row) {
    return String(row[requestIdx]) === String(item.requestId) ||
      (String(row[lessonIdx]) === String(item.lessonId) && String(row[dateIdx]) === String(item.date) && String(row[visitorIdx]).toLowerCase() === String(item.visitorName).toLowerCase());
  });
  if (existing !== -1) {
    if (String(parsed.rows[existing][statusIdx]) === String(item.status)) return { success: true, duplicate: true, walkin: true };
    parsed.rows[existing][statusIdx] = item.status;
    sheet.getRange(existing + 2, 1, 1, headers.length).setValues([parsed.rows[existing]]);
    return { success: true, corrected: true, walkin: true };
  }
  var row = headers.map(function(header) {
    if (header === 'id') return nextId();
    if (header === 'requestId') return safeValue(item.requestId);
    if (header === 'lessonId') return safeValue(item.lessonId);
    if (header === 'date') return safeValue(item.date);
    if (header === 'visitorName') return safeValue(item.visitorName);
    if (header === 'status') return safeValue(item.status);
    if (header === 'isWalkin') return true;
    if (header === 'branchId') return safeValue(lessonBranch);
    if (header === 'recordedBy') return safeValue(auth.username);
    if (header === 'createdAt') return new Date().toISOString();
    return '';
  });
  sheet.appendRow(row);
  return { success: true, walkin: true };
}

function processClientAttendance(item, context) {
  var row = context.clientData[context.clientRowIndex], headers = context.clientHeaders;
  var historyIdx = headers.indexOf('attendanceHistory'), remainingIdx = headers.indexOf('remainingLessons');
  var totalIdx = headers.indexOf('totalLessons'), statusIdx = headers.indexOf('status'), history = parseHistory(row[historyIdx]);
  var existingIdx = history.findIndex(function(entry) { return String(entry.lessonId) === String(item.lessonId) && String(entry.date) === String(item.date); });
  var nextCharged = item.status === 'attended' && item.isWalkin !== true;
  if (existingIdx !== -1) {
    var existing = history[existingIdx];
    if (String(existing.status) === String(item.status) && Boolean(existing.isWalkin) === Boolean(item.isWalkin)) return { success: true, duplicate: true };
    var previousCharged = existing.status === 'attended' && existing.isWalkin !== true;
    var delta = (nextCharged ? 1 : 0) - (previousCharged ? 1 : 0);
    row[remainingIdx] = Math.max(0, Math.min(Number(row[totalIdx] || Number.MAX_SAFE_INTEGER), Number(row[remainingIdx] || 0) - delta));
    existing.status = item.status; existing.isWalkin = item.isWalkin === true; existing.requestId = item.requestId; history[existingIdx] = existing;
  } else {
    history.push({ date: item.date, lessonId: item.lessonId, status: item.status, isWalkin: item.isWalkin === true, requestId: item.requestId });
    if (nextCharged) row[remainingIdx] = Math.max(0, Number(row[remainingIdx] || 0) - 1);
  }
  row[historyIdx] = JSON.stringify(history);
  if (statusIdx !== -1) row[statusIdx] = Number(row[remainingIdx] || 0) <= 0 && nextCharged ? 'Пауза' : 'Активен';
  return { success: true, corrected: existingIdx !== -1 };
}

// Миграция старых строк: раньше оплата сохранялась, а поля абонемента могли
// отсутствовать или быть 0/0. Заполняем их только при точном совпадении
// суммы с прайсом, чтобы не угадывать данные произвольно.
function ensureClientSubscriptionColumns(sheet) {
  var required = ['totalLessons', 'remainingLessons', 'paid', 'purchasedAt', 'receiptUrl', 'attendanceHistory'];
  var headers = getHeaders(sheet);
  required.forEach(function(header) {
    if (headers.indexOf(header) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
      headers = getHeaders(sheet);
    }
  });

  var data = sheet.getDataRange().getValues();
  var idIdx = headers.indexOf('id');
  var frequencyIdx = headers.indexOf('lessonsPerWeek');
  var paidAmountIdx = headers.indexOf('paidAmount');
  var totalIdx = headers.indexOf('totalLessons');
  var remainingIdx = headers.indexOf('remainingLessons');
  var paidIdx = headers.indexOf('paid');
  var purchasedAtIdx = headers.indexOf('purchasedAt');
  var historyIdx = headers.indexOf('attendanceHistory');

  for (var i = 1; i < data.length; i++) {
    var total = Number(data[i][totalIdx] || 0);
    var remaining = Number(data[i][remainingIdx] || 0);
    // The amount is bookkeeping only. The lesson plan is based on frequency,
    // never on whether the entered amount matches a price list.
    var inferredTotal = packageLessonsFromFrequency(data[i][frequencyIdx]);
    if (total <= 0 && remaining <= 0 && inferredTotal > 0) {
      var attended = 0;
      try {
        var history = JSON.parse(data[i][historyIdx] || '[]');
        attended = history.filter(function(entry) { return entry.status === 'attended' && entry.isWalkin !== true; }).length;
      } catch (error) {}
      total = inferredTotal;
      remaining = Math.max(0, inferredTotal - attended);
      sheet.getRange(i + 1, totalIdx + 1).setValue(total);
      sheet.getRange(i + 1, remainingIdx + 1).setValue(remaining);
    }
    if (paidIdx !== -1 && !data[i][paidIdx] && Number(data[i][paidAmountIdx] || 0) > 0) {
      sheet.getRange(i + 1, paidIdx + 1).setValue(true);
    }
  }
  return headers;
}

function sheetContext(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Лист не найден: ' + name);
  var headers = getHeaders(sheet);
  return { sheet: sheet, headers: headers, data: sheet.getDataRange().getValues(), idIdx: headers.indexOf('id') };
}

function appendObject(context, body, subscriptionAware) {
  var row = context.headers.map(function(header) {
    if (header === 'id') return safeValue(body.id || nextId());
    var value = subscriptionAware && body.subscription && body.subscription[header] !== undefined
      ? body.subscription[header]
      : body[header];
    return safeValue(value === undefined ? '' : value);
  });
  context.sheet.appendRow(row);
  var result = {};
  context.headers.forEach(function(header, index) { result[header] = row[index]; });
  return result;
}

function updateEntity(ss, actionToSheet, body, auth) {
  var context = sheetContext(ss, actionToSheet[body.action]);
  var branchIdx = context.headers.indexOf('branchId');
  var rowIndex = findRowById(context.data, context.idIdx, body.id);
  if (rowIndex === -1) throw new Error('Не найдено');
  if (auth.role === 'coach' && branchIdx !== -1 && !branchMatches(auth, context.data[rowIndex][branchIdx])) {
    throw new Error('Доступ к филиалу запрещен');
  }
  var row = context.data[rowIndex].slice();
  context.headers.forEach(function(header, index) {
    if (body[header] === undefined) return;
    var value = Array.isArray(body[header]) && header === 'assignedLessonIds' ? body[header].join(',') : body[header];
    row[index] = safeValue(value);
  });
  context.sheet.getRange(rowIndex + 1, 1, 1, context.headers.length).setValues([row]);
  return { success: true };
}

function deleteEntity(ss, actionToSheet, body, auth) {
  var context = sheetContext(ss, actionToSheet[body.action]);
  var branchIdx = context.headers.indexOf('branchId');
  var rowIndex = findRowById(context.data, context.idIdx, body.id);
  if (rowIndex === -1) throw new Error('Не найдено');
  if (auth.role === 'coach' && branchIdx !== -1 && !branchMatches(auth, context.data[rowIndex][branchIdx])) {
    throw new Error('Доступ к филиалу запрещен');
  }
  context.sheet.deleteRow(rowIndex + 1);
  return { success: true };
}

function addLessonsToClient(ss, body) {
  var context = sheetContext(ss, 'Клиенты');
  var rowIndex = findRowById(context.data, context.idIdx, body.clientId);
  if (rowIndex === -1) throw new Error('Клиент не найден');
  var remainingIdx = context.headers.indexOf('remainingLessons');
  var totalIdx = context.headers.indexOf('totalLessons');
  var statusIdx = context.headers.indexOf('status');
  var count = Number(body.lessonsCount);
  if (!isFinite(count) || count <= 0 || count > 100) throw new Error('Некорректное количество занятий');
  if (remainingIdx !== -1) context.data[rowIndex][remainingIdx] = Number(context.data[rowIndex][remainingIdx] || 0) + count;
  if (totalIdx !== -1) context.data[rowIndex][totalIdx] = Number(context.data[rowIndex][totalIdx] || 0) + count;
  if (statusIdx !== -1) context.data[rowIndex][statusIdx] = 'Активен';
  context.sheet.getRange(rowIndex + 1, 1, 1, context.headers.length).setValues([context.data[rowIndex]]);
  return { success: true };
}

function uploadReceipt(ss, body) {
  var context = sheetContext(ss, 'Клиенты');
  var headers = context.headers;
  var rowIndex = findRowById(context.data, context.idIdx, body.clientId);
  if (rowIndex === -1) throw new Error('Клиент не найден');
  if (!body.fileBase64 || !body.fileName || !body.mimeType) throw new Error('Файл обязателен');
  if (String(body.fileBase64).length > 7 * 1024 * 1024 || String(body.fileName).length > 200) throw new Error('Файл слишком большой');
  if (['image/jpeg', 'image/png', 'application/pdf'].indexOf(String(body.mimeType)) === -1) throw new Error('Недопустимый тип файла');
  var receiptIdx = headers.indexOf('receiptUrl');
  if (receiptIdx !== -1 && context.data[rowIndex][receiptIdx]) revokeReceiptAccess(context.data[rowIndex][receiptIdx]);
  var bytes = Utilities.base64Decode(body.fileBase64);
  if (bytes.length > 5 * 1024 * 1024) throw new Error('Файл слишком большой');
  var file = DriveApp.createFile(Utilities.newBlob(bytes, body.mimeType, body.fileName));
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  var row = context.data[rowIndex].slice();
  var remainingIdx = headers.indexOf('remainingLessons');
  var totalIdx = headers.indexOf('totalLessons');
  var statusIdx = headers.indexOf('status');
  var count = Number(body.lessonsCount || 0);
  if (!isFinite(count) || count < 0 || count > 100) throw new Error('Некорректное количество занятий');
  if (remainingIdx !== -1) row[remainingIdx] = Number(row[remainingIdx] || 0) + count;
  if (totalIdx !== -1) row[totalIdx] = Number(row[totalIdx] || 0) + count;
  if (statusIdx !== -1) row[statusIdx] = 'Активен';
  if (receiptIdx !== -1) row[receiptIdx] = 'drive:' + file.getId();
  context.sheet.getRange(rowIndex + 1, 1, 1, headers.length).setValues([row]);
  return { success: true };
}

function getReceipt(ss, body, auth) {
  var context = sheetContext(ss, 'Клиенты');
  var rowIndex = findRowById(context.data, context.idIdx, body.clientId);
  if (rowIndex === -1) throw new Error('Клиент не найден');
  var branchIdx = context.headers.indexOf('branchId');
  var receiptIdx = context.headers.indexOf('receiptUrl');
  if (branchIdx !== -1 && !branchMatches(auth, context.data[rowIndex][branchIdx])) throw new Error('Доступ к филиалу запрещен');
  var reference = receiptIdx === -1 ? '' : String(context.data[rowIndex][receiptIdx] || '');
  if (!reference) throw new Error('Квитанция не найдена');
  if (reference.indexOf('drive:') !== 0) throw new Error('Старая квитанция требует повторной загрузки');
  var file = DriveApp.getFileById(reference.substring(6));
  var blob = file.getBlob();
  return { success: true, fileName: file.getName(), mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
}

// ==========================================
// 2. ОСНОВНОЙ ОБРАБОТЧИК (doPost)
// ==========================================
function doPost(e) {
  if (!e || !e.postData || !e.postData.contents) return options();
  
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var body = JSON.parse(e.postData.contents);
    
    var scriptSecret = PropertiesService.getScriptProperties().getProperty('GAS_API_SECRET');
    // Fail closed: a missing Script Property must never expose the sheet.
    if (!scriptSecret || scriptSecret.length < 32 || !body.apiKey || body.apiKey !== scriptSecret) {
      return createResponse({ status: 'error', message: 'Unauthorized' });
    }
    var schemaVersion = PropertiesService.getScriptProperties().getProperty('SCHEMA_VERSION');
    if (schemaVersion !== SCHEMA_VERSION) {
      return createResponse({ status: 'error', message: 'Schema is not initialized. Run setupSchema().' });
    }

    // The BFF sends an envelope. Keep action/auth outside of the payload so a
    // browser cannot overwrite the server-provided authorization context.
    var envelope = body;
    var payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
    body = {};
    Object.keys(payload).forEach(function(key) { body[key] = payload[key]; });
    body.action = envelope.action;
    body.auth = envelope.auth;

    if (!isKnownAction(body.action)) throw new Error('Действие не найдено');
    validateRequest(body);
    var auth = null;
    if (body.action !== 'login' && body.action !== 'register') {
      auth = requireServerAuth(body);
      assertGasPermission(body, auth);
      if (['create', 'update', 'delete'].some(function(prefix) { return body.action.indexOf(prefix) === 0; }) ||
          ['recordAttendance', 'recordBulkAttendance', 'uploadReceipt', 'addLessons'].indexOf(body.action) !== -1) {
        invalidateReadCache();
      }
    }
    
    // --- 1. АВТОРИЗАЦИЯ И РЕГИСТРАЦИЯ ---
    if (body.action === 'login') {
      var sheet = getOrCreateUsersSheet(ss);
      var data = sheet.getDataRange().getValues();
      var headers = data[0].map(String);
      var loginKey = 'login-attempts:' + sha256(String(body.username).toLowerCase()).substring(0, 32);
      var loginCache = CacheService.getScriptCache();
      var loginAttempts = Number(loginCache.get(loginKey) || 0);
      if (loginAttempts >= 8) throw new Error('Слишком много попыток. Повторите позже');

      for (var i = 1; i < data.length; i++) {
        if (String(data[i][headers.indexOf('username')]) === String(body.username) && 
            passwordsMatch(body.password, data[i][headers.indexOf('password')])) {
          loginCache.remove(loginKey);
          if (String(data[i][headers.indexOf('password')]).indexOf('v2$') !== 0) {
            sheet.getRange(i + 1, headers.indexOf('password') + 1).setValue(securePasswordHash(body.password));
          }
          return createResponse({ 
            status: 'success', 
            user: {
              id: data[i][headers.indexOf('id')], 
              username: body.username,
              role: data[i][headers.indexOf('role')] || '2',
              branchId: data[i][headers.indexOf('branchId')] || null
            } 
          });
        }
      }
      loginCache.put(loginKey, String(loginAttempts + 1), 900);
      throw new Error('Неверные данные');
    }
    
    if (body.action === 'register') {
      var sheet = getOrCreateUsersSheet(ss);
      var headers = getHeaders(sheet);
      var usernameIdx = headers.indexOf('username');
      var existingUsers = sheet.getDataRange().getValues();
      // Public registration bootstraps only the first administrator.
      var hasUsers = existingUsers.slice(1).some(function(row) {
        return String(row[usernameIdx] || '').trim() !== '';
      });
      if (hasUsers) {
        throw new Error('Первый администратор уже создан. Аккаунты тренеров добавляет администратор.');
      }
      if (existingUsers.slice(1).some(function(row) { return String(row[usernameIdx]).toLowerCase() === String(body.username).toLowerCase(); })) {
        throw new Error('Пользователь с таким логином уже существует');
      }
      var newRow = headers.map(function(h) { 
        if (h === 'id') return nextId();
        if (h === 'password') return securePasswordHash(String(body.password || ''));
        if (h === 'role') return '1';
        if (h === 'branchId') return '';
        return safeValue(body[h] !== undefined ? body[h] : '');
      });
      
      sheet.appendRow(newRow);
      return createResponse({ status: 'success' });
    }

    if (body.action === 'createUser') {
      var userSheet = getOrCreateUsersSheet(ss);
      var userHeaders = getHeaders(userSheet);
      var userRole = normalizeRole(body.role);
      if (!userRole) throw new Error('Недопустимая роль');
      var assignedBranchId = userRole === 'coach' ? resolveBranchId(ss, body.branchId) : String(body.branchId || '').trim();
      var userData = userSheet.getDataRange().getValues();
      var userNameIdx = userHeaders.indexOf('username');
      if (userData.slice(1).some(function(row) {
        return String(row[userNameIdx] || '').trim().toLowerCase() === String(body.username).trim().toLowerCase();
      })) throw new Error('Пользователь с таким логином уже существует');
      var userRow = userHeaders.map(function(header) {
        if (header === 'id') return nextId();
        if (header === 'username') return safeValue(body.username);
        if (header === 'password') return securePasswordHash(String(body.password));
        if (header === 'role') return userRole === 'admin' ? '1' : '2';
        if (header === 'branchId') return safeValue(assignedBranchId);
        return safeValue(body[header] === undefined ? '' : body[header]);
      });
      userSheet.appendRow(userRow);
      return createResponse({ status: 'success', user: { username: body.username, role: userRole, branchId: assignedBranchId || null } });
    }

    if (body.action === 'getUsers') {
      var usersSheet = getOrCreateUsersSheet(ss);
      var usersData = usersSheet.getDataRange().getValues();
      var usersHeaders = usersData[0].map(String);
      var usersResult = usersData.slice(1).map(function(row) {
        return {
          id: String(row[usersHeaders.indexOf('id')] || ''),
          username: String(row[usersHeaders.indexOf('username')] || ''),
          role: normalizeRole(row[usersHeaders.indexOf('role')]),
          branchId: String(row[usersHeaders.indexOf('branchId')] || '') || null
        };
      }).filter(function(user) { return user.id && user.role === 'coach'; });
      return createResponse(usersResult);
    }

    if (body.action === 'assignUserBranch') {
      var assignmentSheet = getOrCreateUsersSheet(ss);
      var assignmentHeaders = getHeaders(assignmentSheet);
      var assignmentData = assignmentSheet.getDataRange().getValues();
      var assignmentIdIdx = assignmentHeaders.indexOf('id');
      var assignmentRoleIdx = assignmentHeaders.indexOf('role');
      var assignmentBranchIdx = assignmentHeaders.indexOf('branchId');
      assertBranchExists(ss, body.branchId);
      var assignmentRow = findRowById(assignmentData, assignmentIdIdx, body.userId);
      if (assignmentRow === -1) throw new Error('Аккаунт не найден');
      if (normalizeRole(assignmentData[assignmentRow][assignmentRoleIdx]) !== 'coach') throw new Error('Можно назначать филиал только тренеру');
      assignmentSheet.getRange(assignmentRow + 1, assignmentBranchIdx + 1).setValue(safeValue(body.branchId));
      return createResponse({ success: true });
    }
    
    // --- 2. GET (getSheet) ---
    if (body.action === 'getClients') {
      return createResponse(getClientsPage(ss, auth, body));
    }

    if (body.action === 'getSheet') {
      var ALLOWED_SHEETS = ['Клиенты', 'Филиалы', 'Тренеры', 'Расписание'];
      if (ALLOWED_SHEETS.indexOf(body.sheet) === -1) throw new Error('Доступ запрещен');
      
      var sheet = ss.getSheetByName(body.sheet);
      if (!sheet) throw new Error('Лист не найден');
      return createResponse(objectsForAuth(sheet, auth, body.branchId));
    }
    
    // --- 3. БИЗНЕС-ЛОГИКА ---
    var actionToSheet = { 
      'recordBulkAttendance': 'Клиенты', 'uploadReceipt': 'Клиенты',
      'updateClient': 'Клиенты', 'updateCoach': 'Тренеры', 'updateLesson': 'Расписание',
      'deleteClient': 'Клиенты', 'deleteCoach': 'Тренеры', 'deleteLesson': 'Расписание',
      'createClient': 'Клиенты', 'createBranch': 'Филиалы', 
      'createCoach': 'Тренеры', 'createLesson': 'Расписание'
    };

    if (['createClient', 'createLesson', 'createCoach'].indexOf(body.action) !== -1) {
      assertScopedBranch(body, auth, ss);
    }
    
    // Attendance is serialized to prevent two coaches from spending the same
    // lesson simultaneously. requestId makes retries safe and corrections are
    // applied as a delta (attended <-> absent), never as another charge.
    if (body.action === 'recordAttendance' || body.action === 'recordBulkAttendance') {
      var attendanceList = body.action === 'recordAttendance'
        ? [{ clientId: body.clientId, status: body.status, isWalkin: body.isWalkin === true, visitorName: body.visitorName || '', date: body.date, lessonId: body.lessonId, requestId: body.requestId }]
        : body.attendance;
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(20000)) throw new Error('Система занята, повторите отметку');
      try {
        var clientBatchSheet = ss.getSheetByName('Клиенты');
        var clientBatchHeaders = clientBatchSheet ? ensureClientSubscriptionColumns(clientBatchSheet) : [];
        var clientBatchData = clientBatchSheet ? clientBatchSheet.getDataRange().getValues() : [];
        var clientBatch = { sheet: clientBatchSheet, headers: clientBatchHeaders, data: clientBatchData };
        var results = attendanceList.map(function(item) {
          try {
            var requestId = item.requestId || body.requestId;
            if (!requestId) throw new Error('Не указан idempotency key');
            item.requestId = String(requestId) + ':' + String(item.clientId || item.visitorName || 'walkin');
            var context = validateAttendanceItem(item, ss, auth, clientBatch);
            if (!context.clientSheet) return processWalkinAttendance(item, ss, auth, context.lessonBranch);
            var result = processClientAttendance(item, context);
            result.clientId = String(item.clientId);
            return result;
          } catch (error) {
            return { clientId: item.clientId || null, success: false, message: String(error.message || error) };
          }
        });
        if (clientBatch.data.length > 1) {
          clientBatch.sheet.getRange(2, 1, clientBatch.data.length - 1, clientBatch.headers.length).setValues(clientBatch.data.slice(1));
        }
        return createResponse({ success: results.every(function(result) { return result.success; }), results: results });
      } finally {
        lock.releaseLock();
      }
    }
    
    if (body.action === 'uploadReceipt') {
      return createResponse(uploadReceipt(ss, body));
    }

    if (body.action === 'getReceipt') {
      return createResponse(getReceipt(ss, body, auth));
    }

    if (body.action === 'addLessons') {
      return createResponse(addLessonsToClient(ss, body));
    }

    if (body.action.indexOf('update') === 0) {
      return createResponse(updateEntity(ss, actionToSheet, body, auth));
    }

    if (body.action.indexOf('delete') === 0) {
      return createResponse(deleteEntity(ss, actionToSheet, body, auth));
    }

    if (body.action === 'createClient' || body.action === 'createLesson') {
      return createResponse(appendObject(sheetContext(ss, body.action === 'createClient' ? 'Клиенты' : 'Расписание'), body, true));
    }

    if (body.action.indexOf('create') === 0) {
      return createResponse(appendObject(sheetContext(ss, actionToSheet[body.action]), body, false));
    }
    
    return createResponse({ status: 'error', message: 'Действие не найдено' });
  } catch (err) {
    return createResponse({ status: 'error', message: err.toString() });
  }
}
