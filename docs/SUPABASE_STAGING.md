# Supabase + Vercel: первый staging без квитанций

Профиль подготовлен для выбранной компактной архитектуры: Supabase предоставляет PostgreSQL, авторизация остаётся Better Auth. Отдельные staging-проекты Supabase и Vercel уже выбраны; публичный deployment ещё не выполнен. Используются только вымышленные данные.

Объём выпуска: [RELEASE_SCOPE.md](RELEASE_SCOPE.md). Общая публичная приёмка: [VERCEL_STAGING.md](VERCEL_STAGING.md). Старый Supabase-проект, XLSX и рабочие данные не становятся staging автоматически.

**Актуально, 10 октября:** после отдельного разрешения владельца все 9 настоящих миграций применены штатным Prisma из одноразовой Vercel build-задачи. История/checksums/27 таблиц/runtime grants/отсутствие anon/authenticated table-доступа проверены; `cloud:verify` через клиент CRM прошла. Operator deployment удалён, CRM-аккаунты автоматически не создавались, приложение ещё не опубликовано. Владелец выполняет `npm run cloud:bootstrap` вручную. Повторять первичную подготовку ролей или инициализацию пустой БД нельзя. Приёмка: [запись](acceptance/supabase-staging-migration-2026-10-10.json), [диагностика и границы выводов](SUPABASE_CONNECTION_DIAGNOSIS.md).

**Последующее упрощение:** `cloud:bootstrap` в Supabase-профиле теперь использует libpq/psql, а не локальную Prisma interactive transaction. Команда/скрытый ввод владельца прежние; Session 5432 и runtime-роль выбираются из проверенного профиля, private env не меняется. Новая `cloud:bootstrap:check` только читает БД и прошла на live staging (admin=0, lock свободен). Runtime на Vercel остаётся Prisma/pg через 6543, max=1 connection на process; Local/self-hosted max=5 не изменён. Короткий порядок запуска: [SIMPLE_STAGING.md](SIMPLE_STAGING.md).

## Подключение и изоляция

- Явный CLOUD_DATABASE_PROVIDER=supabase, точный 20-буквенный CLOUD_SUPABASE_PROJECT_REF и точный shared pooler host из Connect.
- Runtime на Vercel: lotos_runtime.PROJECT_REF, база postgres, shared **Transaction pooler 6543**. `pg` не использует именованные prepared statements; блокировки приложения — транзакционные. Старый малонагруженный Session runtime 5432 принимается для совместимости, но новый шаблон использует 6543.
- Operator DIRECT_URL: отдельный lotos_migrator.PROJECT_REF через тот же Session pooler 5432; допустим прямой db.PROJECT_REF.supabase.co:5432 с username lotos_migrator при доступном IPv6.
- База postgres — имя managed-БД Supabase. Изоляция обеспечивается отдельным проектом и exact ref/endpoint; CLOUD_DATABASE_ISOLATED=true — явное подтверждение оператора, само по себе не доказательство выбора проекта.
- Проверка CA/hostname обязательна. CA из Database Settings передаётся в CLOUD_DATABASE_CA_BASE64; не добавлять rejectUnauthorized=false.
- DATABASE_URL/DIRECT_URL имеют ровно sslmode=verify-full. node-postgres получает явные ca/rejectUnauthorized без URL-параметров, которые иначе заменили бы SSL config. Prisma native migrator получает sslmode=require + sslaccept=strict + временный проверенный sslcert.
- Local/Test/self-hosted профили сохранены; Supabase URL там отвергается. Neon остаётся отдельным поддерживаемым профилем.

Источники: [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres), [Prisma и custom roles](https://supabase.com/docs/guides/database/prisma), [SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement), [Prisma PostgreSQL TLS](https://docs.prisma.io/docs/orm/core-concepts/supported-databases/postgresql).

## Подготовка владельцем/оператором

1. Создать/выбрать новый staging-проект. До любых SQL-команд проверить exact ref, отсутствие рабочих данных и public-таблиц. Отключить Supabase Data API: CRM работает через собственный Next API; anon/authenticated не получают доступ к таблицам CRM.
2. Создать роли через [supabase-staging-roles.sql](../infra/postgres/supabase-staging-roles.sql) в psql операторской сессии. Скрипт атомарный, откажет при существующих public-таблицах/ролях. Никаких BYPASSRLS/CREATEDB для приложения.
3. В интерактивной psql-сессии установить разные случайные 64-символьные hex-пароли через \password. Не передавать их аргументами команд или в чат.
4. Скачать CA PEM из SSL Configuration. Сохранить base64 одной строкой в приватный env.
5. Скопировать [шаблон](../infra/env/.env.vercel.supabase.staging.example) в .env.vercel.staging.local, режим 0600, владелец текущий пользователь, без symlink. Подставить точные endpoint/ref и собственные secrets. Никаких NEXT_PUBLIC credentials.

Под Node.js 22:

```bash
npm run cloud:check:local
npm run cloud:status
npm run cloud:migrate
npm run cloud:verify
npm run cloud:bootstrap
```

Bootstrap выполняет владелец интерактивно. Миграции не запускаются во время build/HTTP. cloud:verify проверяет database/current_user, флаги роли, отсутствие членства в других ролях/владения public-таблицами, statement_timeout=10s и завершённость миграций. Само соединение проверяет CA и hostname.

Bootstrap сначала проверяет доступ к БД и отсутствие администратора, затем спрашивает логин/имя и скрытый пароль (12–200 символов) с повтором. При ошибке вводится только безопасный код: `BOOTSTRAP_PASSWORD_LENGTH` / `BOOTSTRAP_PASSWORD_MISMATCH` означают отказ до создания; `BOOTSTRAP_ALREADY_EXISTS` запрещает повторное создание. `BOOTSTRAP_DB_TIMEOUT` / `BOOTSTRAP_DB_NETWORK` / `BOOTSTRAP_DB_TLS` или Prisma-код после начала создания требуют сначала проверить наличие администратора, а не повторять запись вслепую. Raw errors, SQL, пароль и его длина не печатаются. Сам факт сообщения «создание не подтверждено» не доказывает rollback; подтверждённое создание с ошибкой закрытия соединения сообщается отдельно.

После P2028 владельца обнаружена и адресно откатана оставшаяся runtime-транзакция с auth-lock и незавершённым INSERT accounts; после отката счётчики аккаунтов снова нулевые. Bootstrap теперь ставит transaction-local серверный idle timeout 10 секунд до блокировки, не меняя session/role defaults или HTTP limits. Ошибка также показывает безопасный последний шаг и время. Локальные connect/query timeout воспроизводятся и обычным pg-клиентом на обоих портах; переинициализация БД или замена пароля не обоснованы. Live создание администратора пока не подтверждено; подробности и границы вывода — в [диагностике](SUPABASE_CONNECTION_DIAGNOSIS.md).

`cloud:status` — штатная read-only проверка Prisma, максимум 30 секунд. `cloud:migrate` запускает только Prisma migrate deploy, максимум 180 секунд. На таймауте/отмене завершается собственная группа дочерних процессов; статус 2 не означает rollback: сначала проверить историю, не повторять запись автоматически. Унаследованные DEBUG/engine/TLS overrides очищаются; CA сохраняется до завершения процесса. Ранее предложенный одноразовый SQL-инициализатор удалён, в облаке он не запускался. Используются только версионированные штатные миграции Prisma.

## Vercel

На 10 октября CLI-доступ к `lotos-crm-staging` подтверждён. Настройка проекта исправлена с Node.js 24.x на 22.x и проверена повторным чтением; тариф не менялся. Native Prisma не завершал проверку через Session pooler из локального окружения; из Vercel успешно выполнены настоящие migrate status/deploy/status. Runtime через 6543 и реальная `cloud:verify` проверены. Публичные HTTP, входы и бизнес-операции CRM ещё требуют проверки после bootstrap и публикации.

После отдельного согласия владельца выполнена временная read-only проверка из Vercel build с runtime credentials: SQL через 6543/5432 и native Prisma через 5432 прошли. Минимальный `migrate status` с синтетической схемой завершился за 5.5 секунды с ожидаемым кодом 1 (таблицы миграций нет); локальный аналог завис. `getDatabaseVersion` напрямую в локальном engine также воспроизвёл зависание после успешных SQL. Это локализует сбой, но не устанавливает точный внутренний дефект. Миграционный пароль/DIRECT_URL и приватные файлы Prisma не загружались. Оба диагностических deployment удалены, CLI list подтвердил отсутствие deployments. Тарифы не менялись, платный IPv4 add-on не подключался. Подробности и следующий шаг с отдельным согласованием: [SUPABASE_CONNECTION_DIAGNOSIS.md](SUPABASE_CONNECTION_DIAGNOSIS.md).

Реальная Vercel build использовала Node 22.23.2. Package engines теперь допускает `>=22.23.2 <23`; Local/CI/Docker по-прежнему закреплены на 22.23.3. Cloud Webpack build под 22.23.2 с вымышленными credentials прошёл; это не deployment или real-cloud приёмка приложения.

Runtime-переменные берутся из шаблона, кроме DIRECT_URL и CLOUD_DATABASE_DIRECT_HOST, которые остаются операторскими. CLOUD_MIGRATION_CA_FILE — только временная переменная дочернего migrator, в Vercel не нужна. CA base64 доступен только серверу. DOCUMENT_STORAGE=disabled, Blob keys/store не создавать.

Использовать стабильный адрес нового staging-проекта: VERCEL_ENV=production относится к deployment этого тестового проекта. Preview не получает БД. Публикация — с infra/vercel.staging.json; автоматический Git deployment выключен.

После реального cloud:verify и ручного bootstrap — deployment и приёмка из VERCEL_STAGING.md: оба кабинета, scoped-доступ, расписание/состав/посещаемость/оплата, конфликты, reload, отзыв сессий, CSP, отсутствие файловых запросов. Session mode удерживает connection на время короткой operator-сессии; runtime max=1 относится к одному process, общий лимит платформы проверяется при нагрузке.

## Копии и завершение

Для этого объёма нужна внешняя SQL-копия public-schema и практический restore в отдельный проект/БД с независимой сверкой и входом. Managed backup/dump без проверенного внешнего восстановления не закрывает этап 12. Backup destination, расписание, alerts и RPO/RTO пока ожидают ответа владельца.

Не активировать существующие self-hosted backup scripts на Supabase: они рассчитаны на private Docker host/db/filesystem. После подключения облака требуется проверенная облачная job под read-only lotos_backup. Production-переход — только после публичной приёмки и CUTOVER_RUNBOOK.md.
