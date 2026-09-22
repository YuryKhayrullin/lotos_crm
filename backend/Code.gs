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

// ==========================================
// 2. ОСНОВНОЙ ОБРАБОТЧИК (doPost)
// ==========================================
function doPost(e) {
  console.log('--- РЕАЛЬНЫЕ ДАННЫЕ ПРИШЛИ НА СЕРВЕР ---');
  console.log('Content: ' + (e ? e.postData.contents : 'No data'));

  if (!e || !e.postData || !e.postData.contents) return options();
  
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var body = JSON.parse(e.postData.contents);
    
    // --- ЗАЩИТА: ПРОВЕРКА API KEY ---
    // Получаем секретный ключ из Script Properties Google Таблицы
    var scriptSecret = PropertiesService.getScriptProperties().getProperty('GAS_API_SECRET');
    if (scriptSecret) {
      if (!body.apiKey || body.apiKey !== scriptSecret) {
        console.error('Ошибка безопасности: неверный или отсутствующий apiKey');
        return createResponse({ status: 'error', message: 'Unauthorized' });
      }
    } else {
      console.warn('Предупреждение: GAS_API_SECRET не задан в свойствах скрипта Google Apps Script! База беззащитна.');
    }
    
    // --- НОРМАЛИЗАТОР ---
    if (body.payload) {
      for (var key in body.payload) {
        body[key] = body.payload[key];
      }
    }
    
    // --- 1. АВТОРИЗАЦИЯ И РЕГИСТРАЦИЯ ---
    if (body.action === 'login') {
      var sheet = getOrCreateUsersSheet(ss);
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
      var sheet = getOrCreateUsersSheet(ss);
      var headers = getHeaders(sheet);
      
      var newRow = headers.map(function(h) { 
        if (h === 'id') return new Date().getTime();
        if (h === 'password') return sha256(String(body.password || ''));
        if (h === 'role') return 'pending';
        if (h === 'branchId') return String(body.branchId || '');
        return safeValue(body[h] !== undefined ? body[h] : '');
      });
      
      sheet.appendRow(newRow);
      return createResponse({ status: 'success' });
    }
    
    // --- 2. GET (getSheet) ---
    if (body.action === 'getSheet') {
      var ALLOWED_SHEETS = ['Клиенты', 'Филиалы', 'Тренеры', 'Расписание'];
      if (ALLOWED_SHEETS.indexOf(body.sheet) === -1) throw new Error('Доступ запрещен');
      
      var sheet = ss.getSheetByName(body.sheet);
      if (!sheet) throw new Error('Лист не найден');
      
      var data = sheet.getDataRange().getValues();
      if (data.length <= 1) return createResponse([]);
      
      var headers = data[0];
      return createResponse(data.slice(1).map(function(row) {
        var obj = {};
        headers.forEach(function(h, i) { if (h) obj[h] = row[i]; });
        return obj;
      }));
    }
    
    // --- 3. БИЗНЕС-ЛОГИКА ---
    var actionToSheet = { 
      'recordBulkAttendance': 'Клиенты', 'uploadReceipt': 'Клиенты',
      'updateClient': 'Клиенты', 'updateCoach': 'Тренеры', 'updateLesson': 'Расписание',
      'deleteClient': 'Клиенты', 'deleteCoach': 'Тренеры', 'deleteLesson': 'Расписание',
      'createClient': 'Клиенты', 'createBranch': 'Филиалы', 
      'createCoach': 'Тренеры', 'createLesson': 'Расписание'
    };
    
    // Логика посещаемости
    if (body.action === 'recordAttendance' || body.action === 'recordBulkAttendance') {
      var attendanceList = (body.action === 'recordAttendance') 
        ? [{ clientId: body.clientId, status: body.status, isWalkin: body.isWalkin || false, date: body.date, lessonId: body.lessonId }] 
        : body.attendance;
        
      var sheet = ss.getSheetByName('Клиенты');
      var headers = getHeaders(sheet);
      var data = sheet.getDataRange().getValues();
      var idIdx = headers.indexOf('id');
      var remIdx = headers.indexOf('remainingLessons');
      var statIdx = headers.indexOf('status');
      var histIdx = headers.indexOf('attendanceHistory');
      
      var results = attendanceList.map(function(item) {
        for (var i = 1; i < data.length; i++) {
          if (String(data[i][idIdx]) === String(item.clientId)) {
            // Записываем в историю
            var history = [];
            try { history = JSON.parse(data[i][histIdx] || '[]'); } catch(e) { history = []; }
            history.push({ 
                date: item.date, 
                lessonId: item.lessonId, 
                status: item.status 
            });
            if (histIdx !== -1) sheet.getRange(i + 1, histIdx + 1).setValue(JSON.stringify(history));
            
            // ЛОГИКА СПИСАНИЯ:
            // Если attended и НЕ walkin — списываем занятие
            if (item.status === 'attended' && !item.isWalkin && remIdx !== -1) {
              var newRemaining = Math.max(0, Number(data[i][remIdx] || 0) - 1);
              sheet.getRange(i + 1, remIdx + 1).setValue(newRemaining);
              if (newRemaining <= 0 && statIdx !== -1) sheet.getRange(i + 1, statIdx + 1).setValue('Пауза');
            }
            return { clientId: item.clientId, success: true };
          }
        }
        return { clientId: item.clientId, success: false };
      });
      
      return createResponse({ success: true, results: results });
    }
    
    // Загрузка квитанций
    if (body.action === 'uploadReceipt') {
      var sheet = ss.getSheetByName('Клиенты');
      var headers = getHeaders(sheet);
      var data = sheet.getDataRange().getValues();
      var idIdx = headers.indexOf('id'), remIdx = headers.indexOf('remainingLessons'), totIdx = headers.indexOf('totalLessons'), statIdx = headers.indexOf('status'), receiptIdx = headers.indexOf('receiptUrl');
      
      var receiptUrl = '';
      if (body.fileBase64 && body.fileName) {
        var blob = Utilities.newBlob(Utilities.base64Decode(body.fileBase64), body.mimeType || 'image/jpeg', body.fileName);
        var file = DriveApp.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        receiptUrl = file.getUrl();
      }
      
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][idIdx]) === String(body.clientId)) {
          var lessonsToAdd = Number(body.lessonsCount || 0);
          sheet.getRange(i + 1, remIdx + 1).setValue(Number(data[i][remIdx] || 0) + lessonsToAdd);
          sheet.getRange(i + 1, totIdx + 1).setValue(Number(data[i][totIdx] || 0) + lessonsToAdd);
          sheet.getRange(i + 1, statIdx + 1).setValue('Активен');
          if (receiptIdx !== -1 && receiptUrl) sheet.getRange(i + 1, receiptIdx + 1).setValue(receiptUrl);
          return createResponse({ success: true });
        }
      }
      throw new Error('Клиент не найден');
    }
    
    // UPDATE
    if (body.action.indexOf('update') === 0) {
      var sheet = ss.getSheetByName(actionToSheet[body.action]);
      var headers = getHeaders(sheet);
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
    
    // DELETE
    if (body.action.indexOf('delete') === 0) {
      var sheet = ss.getSheetByName(actionToSheet[body.action]);
      var idIdx = getHeaders(sheet).indexOf('id');
      var data = sheet.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][idIdx]) === String(body.id)) { sheet.deleteRow(i + 1); return createResponse({ success: true }); }
      }
      throw new Error('Не найдено');
    }
    
    // CREATE
    if (body.action === 'createClient' || body.action === 'createLesson') {
      var sheetName = (body.action === 'createClient') ? 'Клиенты' : 'Расписание';
      var sheet = ss.getSheetByName(sheetName);
      var headers = getHeaders(sheet);
      
      var newRow = headers.map(function(h) {
        if (body.subscription && body.subscription[h] !== undefined) {
          return safeValue(body.subscription[h]);
        }
        return safeValue(body[h] !== undefined ? body[h] : '');
      });
      
      console.log('Saving data to ' + sheetName + ': ' + JSON.stringify(newRow));
      sheet.appendRow(newRow);
      
      // Возвращаем созданный объект
      var newObj = {}; 
      headers.forEach(function(h, i) { newObj[h] = newRow[i]; });
      return createResponse(newObj);
    }
    
    // Универсальный CREATE для других сущностей
    if (body.action.indexOf('create') === 0) {
      var sheet = ss.getSheetByName(actionToSheet[body.action]);
      var headers = getHeaders(sheet);
      var newRow = headers.map(function(h) { return safeValue(body[h] || ''); });
      sheet.appendRow(newRow);
      var newObj = {}; headers.forEach(function(h, i) { newObj[h] = newRow[i]; });
      return createResponse(newObj);
    }
    
    return createResponse({ status: 'error', message: 'Действие не найдено' });
  } catch (err) {
    return createResponse({ status: 'error', message: err.toString() });
  }
}
