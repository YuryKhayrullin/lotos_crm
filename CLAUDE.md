@AGENTS.md

1. **Отсутствие авторизации в методе `doGet` (Google Apps Script)**

   - **Где:** `backend/Code.gs`, строчки 37–62 (`doGet`).
   - **В чем опасность:** Функция `doGet` принимает параметры `?sheet=Клиенты` и возвращает все данные таблицы в формате JSON без проверки каких-либо секретных ключей или токенов. Любой, кто узнает URL вашего Google Web App, сможет через обычный браузер или curl-запрос выкачать всю базу данных клиентов (телефоны, email, посещаемость).

2. **Отсутствие проверки ролей (RBAC) в `doPost` (Google Apps Script)**

   - **Где:** `backend/Code.gs`, строчки 67–124 (`doPost`).
   - **В чем опасность:** Бэкенд проверяет только общий секретный ключ `GAS_API_SECRET` между Next.js и Google. Он слепо выполняет любые действия (`deleteClient`, `createBranch`, `updateCoach`), не проверяя, обладает ли пользователь, отправивший запрос, правами администратора. Если злоумышленник обойдет проверку на клиенте или сэмулирует POST-запрос к вашему Next.js API с параметром `action: 'deleteClient'`, база будет изменена.

3. **Хранение токена в `localStorage`**

   - **Где:** `store/AuthStore.ts`, строчки 16 и 58.
   - **В чем опасность:** Токен/флаг сессии сохраняется в `localStorage` (`localStorage.setItem('crm_token', response.token)`). Это делает приложение уязвимым к XSS-атакам: если в каком-то компоненте появится уязвимость внедрения скриптов, злоумышленник сможет украсть сессию.

---

### Схема As-Is (Как данные ходят сейчас)

1. **Клиент (Браузер):** Пользователь нажимает кнопку (например, «Создать клиента» или заходит на страницу). MobX Store вызывает метод `apiClient.createClient(...)`.
2. **API Client (`lib/api-client.ts`):** Отправляет POST-запрос **не в Google**, а на собственный роут Next.js: `fetch('/api/crm', { method: 'POST', body: JSON.stringify({ action, payload }) })`.
3. **BFF Прокси (`app/api/crm/route.ts`):** Next.js сервер принимает запрос, добавляет секретный ключ `apiKey: GAS_API_SECRET` из серверных переменных окружения (`process.env.GAS_API_SECRET`) и перенаправляет его на `GAS_WEBAPP_URL`.
4. **Google Apps Script (`backend/Code.gs`):** Получает POST-запрос, проверяет `apiKey`, выполняет нужное действие (например, `appendRow` на лист `Клиенты`) и возвращает JSON-ответ обратно в Next.js BFF, который передает его на клиент.

_(Плюсом является то, что прямых запросов из браузера в Google Таблицу нет — URL скрипта от клиента скрыт)._

---

### Hardening-план (Инструкции и код для закрытия уязвимостей)

#### Шаг 1. Защита метода `doGet` в Google Apps Script

В файл `backend/Code.gs` добавьте проверку секретного ключа в `doGet`, чтобы никто не мог читать таблицы напрямую по ссылке:

```javascript
function doGet(e) {
  try {
    var params = e && e.parameter ? e.parameter : {}

    // ВАЖНО: Секретный ключ для чтения
    var SECRET_READ_KEY = 'ВАШ_СЕКРЕТНЫЙ_КЛЮЧ_ДЛЯ_ЧТЕНИЯ'
    if (params.apiKey !== SECRET_READ_KEY) {
      return createResponse({ status: 'error', message: 'Доступ запрещен: неверный ключ' })
    }

    var requestedSheet = params.sheet ? params.sheet : 'Клиенты'
    var ALLOWED_SHEETS = ['Клиенты', 'Филиалы', 'Тренеры', 'Расписание']
    if (ALLOWED_SHEETS.indexOf(requestedSheet) === -1) {
      return createResponse({ status: 'error', message: 'Доступ к листу запрещен' })
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(requestedSheet)
    if (!sheet) return createResponse({ status: 'error', message: 'Лист не найден' })

    var data = sheet.getDataRange().getValues()
    if (data.length <= 1) return createResponse([])

    var headers = data[0]
    return createResponse(
      data.slice(1).map(function (row) {
        var obj = {}
        headers.forEach(function (h, i) {
          if (h) obj[h] = row[i]
        })
        return obj
      }),
    )
  } catch (err) {
    return createResponse({ status: 'error', message: err.toString() })
  }
}
```

_(И в `lib/api-client.ts` при запросах на чтение передавайте этот ключ через BFF)._

#### Шаг 2. Проверка прав администратора на бэкенде GAS (`doPost`)

В `backend/Code.gs` защитите административные действия:

```javascript
// Список действий, доступных ТОЛЬКО администраторам
var ADMIN_ACTIONS = ['createUser', 'createBranch', 'deleteClient', 'deleteCoach']

if (ADMIN_ACTIONS.indexOf(body.action) !== -1) {
  // Проверяем роль переданного пользователя (или валидируем токен сессии)
  var userRole = body.userRole || 'coach'
  if (userRole !== 'admin') {
    throw new Error('Ошибка безопасности: недостаточно прав для выполнения этого действия')
  }
}
```

На клиенте / в BFF при отправке запроса всегда передавайте текущую роль пользователя (`userRole: store.authStore.user?.role`).

#### Шаг 3. Защита от инъекций (Sanitization)

У вас уже используется хорошая функция `safeValue(val)` в `Code.gs` (строки 13–18), которая предотвращает формулы-инъекции (`=SUM(...)`, `+CMD(...)` в ячейках Google Таблиц). Убедитесь, что она применяется ко всем входящим текстовым полям при создании и обновлении клиентов/тренеров.

Использование связки **Stateless JWT + HttpOnly Cookies + BFF (Backend-for-Frontend)** — это **золотой стандарт безопасности** для современных веб-приложений (особенно когда в качестве бэкенда выступает Google Apps Script или сторонний API).

Вот почему этот подход идеален для вашей архитектуры и как он решает все описанные выше проблемы:

### 1. Как это работает в вашей схеме:

1. **Аутентификация (Login):**

   - Пользователь вводит логин/пароль на клиенте.
   - Запрос летит в Next.js API (`/api/login`).
   - Next.js проксирует запрос в Google Apps Script (`doPost` с action `login`).
   - Если данные верные, GAS возвращает данные пользователя и JWT-токен (подписанный секретным ключом, содержащий `userId`, `role`, `branchId`).

2. **Сохранение сессии (HttpOnly Cookie):**

   - Вместо записи токена в небезопасный `localStorage` (где его может украсть любой XSS-скрипт), Next.js API устанавливает куку:

     ```ts
     // В роуте Next.js при успешном входе:
     response.cookies.set({
       name: 'crm_session',
       value: jwtToken,
       httpOnly: true, // JS в браузере НЕ имеет доступа к куке (защита от XSS)
       secure: process.env.NODE_ENV === 'production', // Только HTTPS в продакшене
       sameSite: 'strict', // Защита от CSRF
       path: '/',
     })
     ```

3. **Запросы к API через BFF (Проксирование):**

   - Когда клиентское приложение (MobX Store) делает запрос (например, `apiClient.createClient(...)`), браузер **автоматически** прикрепляет HttpOnly куку `crm_session` к запросу на `/api/crm`.

   - **Next.js API Route (`/api/crm/route.ts`) перехватывает этот запрос:**

     - Расшифровывает и проверяет JWT прямо на сервере Next.js.
     - Достает оттуда роль (`admin` / `coach`) и ID филиала.
     - Дописывает к телу запроса проверенные серверные данные (`userRole`, `branchId`) и скрытый `GAS_API_SECRET`.
     - Отправляет запрос в Google Apps Script.

4. **Защита на стороне Google Apps Script:**

   - GAS теперь доверяет только запросам, пришедшим с сервера Next.js (благодаря секретному ключу `GAS_API_SECRET`), а также видит реальную роль пользователя, которую заполнил защищенный BFF, а не злоумышленник с клиентской стороны.

---

### Главные плюсы такого подхода для вас:

- **Защита от XSS:** Токен лежит в `HttpOnly` куке, JavaScript его не видит, украсть его через клиентские уязвимости нельзя.
- **Настоящий контроль доступа (RBAC):** Ни один тренер не сможет «подделать» роль администратора в панели разработчика браузера, потому что роль и права проверяются и жестко проставляются на сервере Next.js на основе подписанного JWT.
- **Чистота фронтенда:** Клиентский код вообще не думает о криптографии, токенах и секретных ключах — он просто шлет запросы на `/api/crm`, а всю безопасность контролирует BFF.
