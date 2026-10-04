# Лотос CRM

CRM для филиалов бассейна: клиенты, абонементы, тренеры, расписание и посещаемость.

## Запуск

    npm install
    npm run dev

Проверки перед production:

    npm run release:check

Полный порядок миграции, smoke-test и контроль следующего рабочего дня описаны в [docs/RELEASE.md](docs/RELEASE.md).

Создайте .env.local:

    GAS_WEBAPP_URL=https://script.google.com/macros/s/.../exec
    GAS_HMAC_SECRET=общий-HMAC-секрет-минимум-32-символа
    SESSION_SECRET=отдельный-случайный-секрет-минимум-32-символа
    UPSTASH_REDIS_REST_URL=https://...upstash.io
    UPSTASH_REDIS_REST_TOKEN=server-only-токен-Redis
    GAS_TIMEOUT_MS=30000

## Google Apps Script

1. Создайте Google Spreadsheet.
2. Откройте Extensions → Apps Script и вставьте содержимое `backend/Code.gs`.
3. В Script Properties добавьте `GAS_HMAC_SECRET` — случайный общий секрет не менее 32 символов.
4. Запустите setupSchema() перед первой публикацией и после обновления схемы. Функция установит SCHEMA_VERSION=12; обычные запросы не выполняют миграцию листов и не переписывают исторические остатки.
5. Для новой таблицы выполните `npm run hash-password`, затем временно задайте в Script Properties `BOOTSTRAP_ADMIN_USERNAME` и выведенный `BOOTSTRAP_ADMIN_PASSWORD_HASH`. После этого вручную запустите `setupInitialAdmin()`: функция создаёт только первого администратора и сразу удаляет оба временных свойства.
6. Разверните Web App и после каждого изменения Code.gs создавайте новую версию deployment.
7. GAS принимает только HMAC-подписанный envelope от BFF; секрет никогда не передаётся в теле запроса.

Минимальные листы и заголовки:

- Users: id, username, password, role, branchId, status, disabledAt, disabledBy.
- Филиалы: id, name, address.
- Тренеры: id, name, specialty, initials, branchId, userId, phone, birthDate.
- Расписание: id, branchId, date, dayOfWeek, time, title, category, coachName, pool, duration, maxCapacity, count, isRecurring.
- Клиенты: id, childName, parentName, phone, email, birthDate, age, branchId, status, category, lessonsPerWeek, initials, paidAmount, totalLessons, remainingLessons, paid, purchasedAt, receiptUrl, assignedLessonId, assignedLessonIds, attendanceHistory.
- Посещения: id, requestId, lessonId, date, clientId, visitorName, status, isWalkin, branchId, recordedBy, createdAt.
- Платежи: id, requestId, clientId, branchId, amount, category, lessonsPerWeek, packagePrice, packageLessons, packagesCount, lessonsAdded, paidAt, recordedBy, comment, requestFingerprint.
- Журнал занятий: id, requestId, clientId, branchId, paymentId, type, lessonsDelta, totalLessonsDelta, balanceBefore, balanceAfter, totalLessonsBefore, totalLessonsAfter, createdAt, recordedBy, comment, reason, requestFingerprint.
- Журнал администрирования: id, requestId, action, entityType, entityId, branchId, actorId, recordedBy, changedFields, reason, source, createdAt, requestFingerprint.

Заголовки читаются динамически, но перечисленные имена менять нельзя без изменения normalizers и Code.gs. `setupSchema()` добавляет `userId`, `phone`, `birthDate` в «Тренеры», недостающие поля `date`, `category`, `isRecurring` в «Расписание» и задаёт текстовый формат колонкам `date` и `time`. Для старых записей без даты она не угадывает дату: укажите её вручную после проверки исходного расписания.

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

Пароли хранятся только как `scrypt$...`; GAS не получает открытые пароли и не проверяет их. После миграции старые `v2$...` и SHA-256 значения намеренно не работают: это принудительный сброс, а не небезопасная миграция при входе. Для существующего администратора сгенерируйте хеш командой `npm run hash-password`, временно задайте `BOOTSTRAP_ADMIN_USERNAME` и `BOOTSTRAP_ADMIN_PASSWORD_HASH`, затем запустите `resetBootstrapAdminPassword()` в Apps Script. Войдите и сбросьте пароли тренерам через раздел «Тренеры».

## Attendance

Отметки используют ISO-даты и requestId. Повторная отправка не списывает занятие второй раз, в том числе при нулевом остатке. Исправление attended/absent меняет остаток по разнице статусов; в истории сохраняется recordedBy. Для настоящего walk-in используется лист Посещения без clientId и без списания абонемента. Для клиента с карточкой вариант без списания запрещён.

## Бухгалтерия абонементов

Количество занятий и остаток изменяются только тремя журналируемыми действиями: подтверждённым платежом, посещением (включая исправление отметки) и административной корректировкой. `lessonsPerWeek` — настройка следующей покупки; редактирование карточки клиента не меняет уже оплаченный пакет.

В карточке клиента администратор видит сверку строки клиента, «Платежей» и «Журнала занятий». Аудит только читает данные. Если он находит пропущенную связь с подтверждённым платежом или старый баланс, сначала проверьте результат, затем укажите причину и подтвердите отдельное исправление. При противоречивых строках журнала или платежа автоматическое исправление заблокировано: такие записи нужно проверить вручную.

Колонки `paidAmount`, `totalLessons`, `remainingLessons`, `paid`, `purchasedAt`, `receiptUrl`, `attendanceHistory` и `paymentBalance` нельзя править вручную в Google Sheets. `setupSchema()` добавляет к ним предупреждающую защиту; при обходе предупреждения триггер `onEdit` пишет запись без значений ячеек в «Журнал администрирования», сбрасывает кэш, а сверка журнала блокирует дальнейшие операции с расходящимся балансом. Административные действия BFF имеют `requestId`, общий mutation lock и пишут в этот журнал только имена изменённых полей — без паролей, хешей или персональных значений.

## Квитанции

Новые квитанции хранятся приватно в Google Drive как drive:fileId. Публичные ссылки не выдаются. Скачивание выполняется только авторизованным администратором через /api/receipts/:clientId. Загрузка файла — только доказательство оплаты и никогда не начисляет занятия. Старые записи с публичным URL нужно повторно загрузить.

## Деплой и секреты

Перед production:

1. Сгенерируйте новый `GAS_HMAC_SECRET` и задайте одинаковое значение в Script Properties GAS и environment variables BFF.
2. Установите отдельный `SESSION_SECRET`.
3. Настройте `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN`; без них production намеренно не принимает вход.
4. Сначала сохраните и разверните новый GAS, затем выполните `setupSchema()` и убедитесь, что он вернул `Schema 12 is ready`.
5. До рабочих операций откройте карточки клиентов под администратором и проверьте «Сверку журнала занятий». Подтверждайте исправление только после проверки его причины и ожидаемых остатков; противоречивые записи исправляйте вручную.
6. Сгенерируйте scrypt-хеш. Для существующей базы вызовите `resetBootstrapAdminPassword()`, для новой — `setupInitialAdmin()`.
7. Разверните BFF/Next.js с новыми environment variables.
8. Проверьте одинаковую ошибку неверного логина/пароля, лимиты IP+логин и IP, вход активного и отключённого тренера, RBAC, branch scope, платежи, корректировку, attendance, сверку журнала и квитанции тестовыми аккаунтами.
