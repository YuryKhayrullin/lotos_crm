// ==========================================
// 1. ИНФРАСТРУКТУРА ОТВЕТОВ (CORS включен)
// ==========================================
function createResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function options() {
  return createResponse({ status: 'success' });
}

function safeValue(val) {
  if (val === undefined || val === null) return '';
  var str = String(val).trim();
  if (str.indexOf('=') === 0 || str.indexOf('+') === 0) return "'" + str;
  return str;
}

// Хэширование для безопасности
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

// ==========================================
// 2. GET
// ==========================================
function doGet(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : { sheet: 'Клиенты' };
    var requestedSheet = (params && params.sheet) ? params.sheet : 'Клиенты';
    
    var ALLOWED_SHEETS = ['Клиенты', 'Филиалы', 'Тренеры', 'Расписание'];
    if (ALLOWED_SHEETS.indexOf(requestedSheet) === -1) {
      return createResponse({ status: 'error', message: 'Доступ к листу запрещен' });
    }
    
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(requestedSheet);
    if (!sheet) return createResponse({ status: 'error', message: 'Лист не найден' });
    
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return createResponse([]);
    
    var headers = data[0];
    return createResponse(data.slice(1).map(function(row) {
      var obj = {};
      headers.forEach(function(h, i) { if (h) obj[h] = row[i]; });
      return obj;
    }));
  } catch (err) {
    return createResponse({ status: 'error', message: err.toString() });
  }
}

// ==========================================
// 3. POST
// ==========================================
function doPost(e) {
  if (!e || !e.postData || !e.postData.contents) return options();
  
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var body = JSON.parse(e.postData.contents);
    
    // --- АВТОРИЗАЦИЯ ---
    if (body.action === 'login') {
      var sheet = ss.getSheetByName('Users');
      var data = sheet.getDataRange().getValues();
      var headers = data[0].map(String);
      var hashedLoginPassword = sha256(String(body.password)); 
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][headers.indexOf('username')]) === String(body.username) && 
            String(data[i][headers.indexOf('password')]) === hashedLoginPassword) {
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
      throw new Error('Неверные данные');
    }
    
    if (body.action === 'register') {
      var sheet = ss.getSheetByName('Users');
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      sheet.appendRow(headers.map(function(h) { 
        if (h === 'id') return new Date().getTime();
        if (h === 'password') return sha256(body.password);
        if (h === 'role') return body.role || '2';
        // Явно берем branchId, если он есть в body
        if (h === 'branchId') return safeValue(body.branchId || ''); 
        return safeValue(body[h] || '');
      }));
      return createResponse({ status: 'success' });
    }

    // --- БИЗНЕС-ЛОГИКА ---
    var actionToSheet = { 
      'recordBulkAttendance': 'Клиенты',
      'uploadReceipt': 'Клиенты',
      'updateClient': 'Клиенты', 
      'updateCoach': 'Тренеры', 
      'deleteClient': 'Клиенты', 
      'deleteCoach': 'Тренеры', 
      'createClient': 'Клиенты', 
      'createBranch': 'Филиалы', 
      'createCoach': 'Тренеры', 
      'createLesson': 'Расписание', 
      'updateLesson': 'Расписание' 
    };

    if (body.action === 'recordAttendance') {
      body.action = 'recordBulkAttendance';
      body.attendanceList = [{ clientId: body.clientId, status: body.status }];
    }
    
    if (body.action === 'recordBulkAttendance') {
      var sheet = ss.getSheetByName('Клиенты');
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var data = sheet.getDataRange().getValues();
      var idIdx = headers.indexOf('id'), remIdx = headers.indexOf('remainingLessons'), statIdx = headers.indexOf('status'), histIdx = headers.indexOf('attendanceHistory');
      
      (body.attendanceList || []).forEach(function(item) {
        for (var i = 1; i < data.length; i++) {
          if (String(data[i][idIdx]) === String(item.clientId)) {
            var history = [];
            try { history = JSON.parse(data[i][histIdx] || '[]'); } catch(e) { history = []; }
            history.push({ date: body.date, lessonId: body.lessonId, status: item.status });
            if (histIdx !== -1) sheet.getRange(i + 1, histIdx + 1).setValue(JSON.stringify(history));
            
            if (item.status === 'attended' && remIdx !== -1) {
              var currentRemaining = Number(data[i][remIdx] || 0);
              if (currentRemaining > 0) {
                var newRemaining = currentRemaining - 1;
                sheet.getRange(i + 1, remIdx + 1).setValue(newRemaining);
                if (newRemaining <= 0 && statIdx !== -1) sheet.getRange(i + 1, statIdx + 1).setValue('Пауза');
              }
            }
            break;
          }
        }
      });
      return createResponse({ success: true });
    }

    if (body.action === 'uploadReceipt') {
      var sheet = ss.getSheetByName('Клиенты');
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var data = sheet.getDataRange().getValues();
      var idIdx = headers.indexOf('id'), remIdx = headers.indexOf('remainingLessons'), totIdx = headers.indexOf('totalLessons'), statIdx = headers.indexOf('status'), receiptIdx = headers.indexOf('receiptUrl');
      
      var lessonsToAdd = Number(body.lessonsCount || 0);
      var receiptUrl = '';
      if (body.fileBase64 && body.fileName) {
        var decoded = Utilities.base64Decode(body.fileBase64);
        var blob = Utilities.newBlob(decoded, body.mimeType || 'image/jpeg', body.fileName);
        var file = DriveApp.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        receiptUrl = file.getUrl();
      }
      
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][idIdx]) === String(body.clientId)) {
          var newRemaining = Number(data[i][remIdx] || 0) + lessonsToAdd;
          var newTotal = Number(data[i][totIdx] || 0) + lessonsToAdd;
          sheet.getRange(i + 1, remIdx + 1).setValue(newRemaining);
          sheet.getRange(i + 1, totIdx + 1).setValue(newTotal);
          sheet.getRange(i + 1, statIdx + 1).setValue('Активен');
          if (receiptIdx !== -1 && receiptUrl) sheet.getRange(i + 1, receiptIdx + 1).setValue(receiptUrl);
          return createResponse({ success: true, remainingLessons: newRemaining });
        }
      }
      throw new Error('Клиент не найден');
    }
    
    // UPDATE / DELETE / CREATE
    if (body.action.indexOf('update') === 0) {
      var sheet = ss.getSheetByName(actionToSheet[body.action]);
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var data = sheet.getDataRange().getValues();
      var idIdx = headers.indexOf('id');
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][idIdx]) === String(body.id)) {
          headers.forEach(function(h, idx) { if (body[h] !== undefined) sheet.getRange(i + 1, idx + 1).setValue(safeValue(body[h])); });
          return createResponse({ success: true });
        }
      }
      throw new Error('Не найдено');
    }
    
    if (body.action.indexOf('delete') === 0) {
      var sheet = ss.getSheetByName(actionToSheet[body.action]);
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var data = sheet.getDataRange().getValues();
      var idIdx = headers.indexOf('id');
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][idIdx]) === String(body.id)) { sheet.deleteRow(i + 1); return createResponse({ success: true }); }
      }
      throw new Error('Не найдено');
    }
    
    // ИСПРАВЛЕННЫЙ БЛОК CREATE: ВОЗВРАЩАЕТ ОБЪЕКТ
    if (['createClient', 'createBranch', 'createCoach', 'createLesson'].indexOf(body.action) !== -1) {
      var sheet = ss.getSheetByName(actionToSheet[body.action]);
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      
      var newRow = headers.map(function(h) { return safeValue(body[h] !== undefined ? body[h] : ''); });
      sheet.appendRow(newRow);
      
      var newObj = {};
      headers.forEach(function(h, i) { newObj[h] = newRow[i]; });
      return createResponse(newObj); // ВЕРНУЛИ ОБЪЕКТ!
    }
    
    return createResponse({ status: 'error', message: 'Действие не найдено' });
      
  } catch (err) {
    return createResponse({ status: 'error', message: err.toString() });
  }
}