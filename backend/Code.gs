function createCORSResponse(output) {
     2   return output
     3     .setMimeType(ContentService.MimeType.JSON)
     4     .setHeader("Access-Control-Allow-Origin", "*")
     5     .setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
     6     .setHeader("Access-Control-Allow-Headers", "Content-Type");
     7 }
     8
     9 function options(e) {
    10   return createCORSResponse(ContentService.createTextOutput(""));
    11 }
    12
    13 function doGet(e) {
    14   var params = (e && e.parameter) ? e.parameter : {};
    15   var sheetName = params.sheet || 'Клиенты';
    16   var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    17   
    18   if (!sheet) {
    19     return createCORSResponse(ContentService.createTextOutput(JSON.stringify({error: 'Лист ' + sheetName + ' не найден'})));
    20   }
    21   
    22   var data = sheet.getDataRange().getValues();
    23   if (data.length <= 1) {
    24     return createCORSResponse(ContentService.createTextOutput(JSON.stringify([])));
    25   }
    26   
    27   var headers = data[0];
    28   var rows = data.slice(1);
    29   var result = rows.map(function(row) {
    30     var obj = {};
    31     headers.forEach(function(header, index) { if (header) obj[header] = row[index]; });
    32     return obj;
    33   });
    34   
    35   return createCORSResponse(ContentService.createTextOutput(JSON.stringify(result)));
    36 }
    37
    38 function doPost(e) {
    39   try {
    40     var ss = SpreadsheetApp.getActiveSpreadsheet();
    41     var body = JSON.parse(e.postData.contents);
    42     
    43     // --- 1. АВТОРИЗАЦИЯ ---
    44     if (body.action === 'login') {
    45       var userSheet = ss.getSheetByName('Users');
    46       var data = userSheet.getDataRange().getValues();
    47       var headers = data[0].map(String);
    48       var rows = data.slice(1);
    49       
    50       var uIdx = headers.indexOf('username');
    51       var pIdx = headers.indexOf('password');
    52       
    53       for (var i = 0; i < rows.length; i++) {
    54         if (String(rows[i][uIdx]) === String(body.username) && String(rows[i][pIdx]) === String(body.password)) {
    55           return createCORSResponse(ContentService.createTextOutput(JSON.stringify({ 
    56             status: 'success', 
    57             user: {id: rows[i][headers.indexOf('id')], username: body.username},
    58             token: 'token-' + new Date().getTime() 
    59           })));
    60         }
    61       }
    62       throw new Error('Неверный логин или пароль');
    63     }
    64     
    65     // --- 2. РЕГИСТРАЦИЯ ---
    66     if (body.action === 'register') {
    67       var userSheet = ss.getSheetByName('Users');
    68       var headers = userSheet.getRange(1, 1, 1, userSheet.getLastColumn()).getValues()[0];
    69       var newId = new Date().getTime();
    70       var newRow = headers.map(function(h) {
    71         if (h === 'id') return newId;
    72         if (h === 'username') return body.username;
    73         if (h === 'password') return body.password;
    74         if (h === 'role') return '2';
    75         return '';
    76       });
    77       userSheet.appendRow(newRow);
    78       return createCORSResponse(ContentService.createTextOutput(JSON.stringify({ status: 'success' })));
    79     }
    80
    81     // --- 3. UPDATE ---
    82     if (body.action === 'updateClient') {
    83       var sheet = ss.getSheetByName('Клиенты');
    84       var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    85       var dataRows = sheet.getDataRange().getValues();
    86       var idColIndex = headers.indexOf('id');
    87       var clientRow = -1;
    88       
    89       for (var i = 1; i < dataRows.length; i++) {
    90         if (String(dataRows[i][idColIndex]) === String(body.id)) {
    91           clientRow = i + 1;
    92           break;
    93         }
    94       }
    95       
    96       if (clientRow !== -1) {
    97         headers.forEach(function(header, index) {
    98           if (body[header] !== undefined) {
    99             sheet.getRange(clientRow, index + 1).setValue(body[header]);
   100           }
   101         });
   102         return createCORSResponse(ContentService.createTextOutput(JSON.stringify({success: true})));
   103       }
   104       throw new Error('Клиент не найден');
   105     }
   106     
   107     // --- 4. CREATE ---
   108     var sheetName = 'Клиенты';
   109     if (body.action === 'createBranch') sheetName = 'Филиалы';
   110     if (body.action === 'createCoach') sheetName = 'Тренеры';
   111     var sheet = ss.getSheetByName(sheetName);
   112     var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
   113     var newRow = headers.map(function(header) { return body[header] !== undefined ? body[header] : ''; });
   114     sheet.appendRow(newRow);
   115     
   116     return createCORSResponse(ContentService.createTextOutput(JSON.stringify({ status: 'success' })));
   117       
   118   } catch (err) {
   119     return createCORSResponse(ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.toString() })));
   120   }
   121 }