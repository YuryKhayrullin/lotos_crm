# Лотос CRM

CRM для филиалов бассейна: клиенты, абонементы, тренеры, расписание и посещаемость.

## Запуск

    npm install
    npm run dev

Проверки перед production:

    npm run typecheck
    npm test
    npm run lint
    npm run format:check
    npm run build

Создайте .env.local:

    GAS_WEBAPP_URL=https://script.google.com/macros/s/.../exec
    GAS_API_SECRET=секрет-тот-же-в-Google-Script-Properties
    SESSION_SECRET=отдельный-случайный-секрет-минимум-32-символа
    GAS_TIMEOUT_MS=30000

## Google Apps Script

1. Создайте Google Spreadsheet.
2. Откройте Extensions → Apps Script и вставьте содержимое `backend/Code.gs`.
3. В Script Properties добавьте GAS_API_SECRET.
4. Запустите setupSchema() перед первой публикацией и после обновления схемы. Функция установит SCHEMA_VERSION=6; обычные запросы не выполняют миграцию листов.
5. Для новой таблицы в Script Properties временно задайте `BOOTSTRAP_ADMIN_USERNAME` и `BOOTSTRAP_ADMIN_PASSWORD` (не менее 8 символов), затем вручную запустите `setupInitialAdmin()`. Функция создаёт только первого администратора и сразу удаляет оба временных свойства.
6. Разверните Web App и после каждого изменения Code.gs создавайте новую версию deployment.
7. GAS принимает только запросы с правильным секретом и серверным auth-контекстом BFF.

Минимальные листы и заголовки:

- Users: id, username, password, role, branchId, status, disabledAt, disabledBy.
- Филиалы: id, name, address.
- Тренеры: id, name, specialty, initials, branchId, userId.
- Расписание: id, branchId, date, dayOfWeek, time, title, category, coachName, pool, duration, maxCapacity, count, isRecurring.
- Клиенты: id, childName, parentName, phone, email, birthDate, age, branchId, status, category, lessonsPerWeek, initials, paidAmount, totalLessons, remainingLessons, paid, purchasedAt, receiptUrl, assignedLessonId, assignedLessonIds, attendanceHistory.
- Посещения: id, requestId, lessonId, date, clientId, visitorName, status, isWalkin, branchId, recordedBy, createdAt.
- Платежи: id, requestId, clientId, branchId, amount, category, lessonsPerWeek, packagePrice, packageLessons, packagesCount, lessonsAdded, paidAt, recordedBy, comment, requestFingerprint.

Заголовки читаются динамически, но перечисленные имена менять нельзя без изменения normalizers и Code.gs. `setupSchema()` добавляет недостающие поля `date`, `category`, `isRecurring` в «Расписание» и задаёт текстовый формат колонкам `date` и `time`. Для старых записей без даты она не угадывает дату: укажите её вручную после проверки исходного расписания.

## Архитектура

- app — App Router, auth routes, BFF и защищённый endpoint квитанций.
- components — UI и экраны CRM.
- store — MobX-State-Tree stores и модели.
- lib/api-client.ts — типизированный клиент BFF.
- lib/server — HttpOnly-сессия, GAS client и RBAC policy.
- backend/Code.gs — операции Sheets, LockService, branch scope и DTO-проверки.

## Авторизация и роли

Тренер открывает занятие в расписании на конкретную дату. Список назначенных детей загружается отдельно от постраничного списка клиентов, не зависит от его поиска и исключает архивные карточки. Сервер проверяет филиал и дату занятия; для повторяющегося занятия — день недели и дату начала. Отметки отправляются пачками по 100, чтобы большие группы не превышали лимит GAS; при повторе уже сохранённые отметки не списываются снова.

Сессия хранится в подписанной HttpOnly-cookie. JWT не хранится в localStorage или sessionStorage и недоступен JavaScript в браузере.

Публичной регистрации нет. Первый аккаунт администратора создаётся только вручную через `setupInitialAdmin()` и временные Script Properties. Остальные учётные записи создаёт администратор в разделе «Тренеры» вместе с карточкой тренера и выбранным филиалом. Там же администратор может отключить или активировать вход, назначить филиал и сбросить пароль. При отключении история платежей и посещений сохраняется, но все дальнейшие запросы этого аккаунта отклоняются. Для старых карточек без `userId` сначала вручную свяжите подходящий аккаунт того же филиала; удаление связанной карточки деактивирует её аккаунт. Администратор использует role=1, тренер — role=2.

## Attendance

Отметки используют ISO-даты и requestId. Повторная отправка не списывает занятие второй раз, в том числе при нулевом остатке. Исправление attended/absent меняет остаток по разнице статусов; в истории сохраняется recordedBy. Для настоящего walk-in используется лист Посещения без clientId и без списания абонемента. Для клиента с карточкой вариант без списания запрещён.

## Квитанции

Новые квитанции хранятся приватно в Google Drive как drive:fileId. Публичные ссылки не выдаются. Скачивание выполняется только авторизованным администратором через /api/receipts/:clientId. Старые записи с публичным URL нужно повторно загрузить.

## Деплой и секреты

Перед production:

1. Сгенерируйте новый GAS_API_SECRET.
2. Замените его в Script Properties и environment variables приложения.
3. Установите отдельный SESSION_SECRET.
4. Выполните setupSchema() и убедитесь, что он вернул `Schema 6 is ready`.
5. Для новой базы создайте первого администратора через временные `BOOTSTRAP_ADMIN_*` и `setupInitialAdmin()`.
6. Создайте новую версию GAS Web App.
7. Проверьте вход активного и отключённого тренера, RBAC, branch scope, attendance и квитанции тестовыми аккаунтами.
