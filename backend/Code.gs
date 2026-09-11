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

// ==========================================
// 2. GET
// ==========================================
function doGet(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : { sheet: 'Клиенты' };
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(params.sheet || 'Клиенты');
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
    
    // А) ЛОГИКА recordBulkAttendance
    if (body.action === 'recordBulkAttendance') {
      var sheet = ss.getSheetByName('Клиенты');
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var data = sheet.getDataRange().getValues();
      var idIdx = headers.indexOf('id'), remIdx = headers.indexOf('remainingLessons'), statIdx = headers.indexOf('status'), histIdx = headers.indexOf('attendanceHistory');
      
      body.attendanceList.forEach(function(item) {
        for (var i = 1; i < data.length; i++) {
          if (String(data[i][idIdx]) === String(item.clientId)) {
            var history = [];
            try { history = JSON.parse(data[i][histIdx] || '[]'); } catch(e) { history = []; }
            history.push({ date: body.date, lessonId: body.lessonId, status: item.status });
            sheet.getRange(i + 1, histIdx + 1).setValue(JSON.stringify(history));
            
            if (item.status === 'attended') {
              var currentRemaining = Number(data[i][remIdx] || 0);
              if (currentRemaining > 0) {
                var newRemaining = currentRemaining - 1;
                sheet.getRange(i + 1, remIdx + 1).setValue(newRemaining);
                if (newRemaining <= 0) sheet.getRange(i + 1, statIdx + 1).setValue('Пауза');
              }
            }
            break;
          }
        }
      });
      return createResponse({ success: true });
    }
    
    // Б) АВТОРИЗАЦИЯ
    if (body.action === 'login') {
      var sheet = ss.getSheetByName('Users');
      var data = sheet.getDataRange().getValues();
      var headers = data[0].map(String);
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][headers.indexOf('username')]) === String(body.username) && String(data[i][headers.indexOf('password')]) === String(body.password)) {
          return createResponse({ status: 'success', user: {id: data[i][headers.indexOf('id')], username: body.username} });
        }
      }
      throw new Error('Неверные данные');
    }
    
    // В) РЕГИСТРАЦИЯ
    if (body.action === 'register') {
      var sheet = ss.getSheetByName('Users');
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      sheet.appendRow(headers.map(function(h) { return h === 'id' ? new Date().getTime() : (h === 'role' ? '2' : safeValue(body[h] || '')); }));
      return createResponse({ status: 'success' });
    }
    
    // Г) UPDATE / CREATE / DELETE
    var actionToSheet = {
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
    var sheetName = actionToSheet[body.action] || 'Клиенты';
    var sheet = ss.getSheetByName(sheetName);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    
    if (body.action.indexOf('update') === 0) {
      var data = sheet.getDataRange().getValues();
      var idIdx = headers.indexOf('id');
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][idIdx]) === String(body.id)) {
          headers.forEach(function(h, idx) { 
            if (body[h] !== undefined) {
              var val = body[h];
              // Гарантируем числовой формат для счетчиков занятий
              if (h === 'remainingLessons' || h === 'totalLessons') {
                val = Number(val);
                sheet.getRange(i + 1, idx + 1).setValue(val);
              } else {
                sheet.getRange(i + 1, idx + 1).setValue(safeValue(val));
              }
            }
          });
          return createResponse({ success: true });
        }
      }
      throw new Error('Не найдено');
    }
    
    if (body.action.indexOf('delete') === 0) {
      var data = sheet.getDataRange().getValues();
      var idIdx = headers.indexOf('id');
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][idIdx]) === String(body.id)) { sheet.deleteRow(i + 1); return createResponse({ success: true }); }
      }
      throw new Error('Не найдено');
    }
    
    sheet.appendRow(headers.map(function(h) { return safeValue(body[h] !== undefined ? body[h] : ''); }));
    return createResponse({ status: 'success' });
      
  } catch (err) {
    return createResponse({ status: 'error', message: err.toString() });
  }
}