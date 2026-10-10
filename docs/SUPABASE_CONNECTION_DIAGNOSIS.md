# Диагностика подключения, 10 октября 2026

## Последний отказ libpq bootstrap: причина пока не установлена

Следующая ручная попытка с checkpoints дошла до `admin-check` и завершилась локальным process timeout через 30 секунд. Немедленный read-only контроль после неё снова подтвердил admins=0, свободный auth-lock и отсутствие созданного аккаунта. Значит сервер принял соединение, BEGIN, guards и advisory lock, но локальный клиент не получил завершение серверного блока; этот результат не указывает на Prisma, неправильный пароль или неприменённые миграции.

Для первого администратора добавлен более прямой fallback `npm run cloud:bootstrap:sql`: он локально получает данные скрыто и создаёт mode 0600 файл `.private/supabase-first-admin.sql`, исключённый из Git/Vercel. В файле есть необратимый Better Auth hash, но нет открытого пароля. Весь файл один раз выполняется владельцем в SQL Editor **этого staging-проекта**; transaction lock, admin guard и атомарные user+credential+audit сохранены. После подтверждения результата файл удаляется. Это исключает нестабильный локальный WSL/Docker→pooler участок только из одноразового bootstrap; Prisma runtime приложения не заменяется. Проверка fallback: 27 целевых Node, 9 native-bootstrap и 36 auth на disposable PostgreSQL, включая реальное исполнение SQL Editor-варианта и вход через прежний HTTP/Better Auth; TypeScript/ESLint/форматирование прошли.

Ручной запуск владельца вернул `BOOTSTRAP_PSQL_FAILED`. После него read-only проверки показали users/admins/accounts/bootstrap audit = 0, auth-management lock свободен. Runtime имеет INSERT на users/accounts/audit_events и USAGE языка plpgsql; RLS на этих таблицах выключен, database default_transaction_read_only = off. Эти проверки исключают отсутствие базовых прав на вставку, но не доказывают исправность всех триггеров или транспорта.

Старый обработчик подавил исходный stderr без извлечения SQLSTATE, поэтому точную причину именно этого отказа восстановить из сообщения нельзя. Обработчик теперь извлекает только allowlisted пятисимвольный SQLSTATE и последний фиксированный checkpoint. Полный verbose stderr, SQL, пользовательский ввод и credential hash по-прежнему не выводятся. Добавлены checkpoints до BEGIN/guard/lock/COMMIT и внутри DO до проверки admin/вставок. Это исправление диагностики, не объявленное устранение исходного сбоя.

Короткий и дополненный синтетическим комментарием 4 КиБ SELECT прошли; минимальный read-only DO также прошёл. Дополнительная read-only EXPLAIN-проверка вставок без ANALYZE прервалась по timeout. Поэтому размер запроса и сам DO не установлены как причина. Агент повторное создание cloud-аккаунта не запускал, права/пароли/миграции не менял. Следующий шаг — один ручной запуск владельца с безопасным кодом и checkpoint; после любого неизвестного результата сначала проверяется наличие администратора.

Приёмка диагностического изменения: 21 целевая Node-проверка и отдельно 8 native-bootstrap + 36 auth на disposable Test PostgreSQL; TypeScript и ESLint прошли. Эти проверки не заменяют успешный bootstrap на настоящей staging-БД.

## Последующее практическое упрощение

По просьбе владельца сократить сложность без потери функционала Supabase owner-bootstrap переключён на проверенный libpq/psql транспорт, без изменения Prisma runtime или истории миграций. Команда `cloud:bootstrap` и скрытый ввод прежние; живой Node/Prisma клиент не создаётся при этом профиле. Read-only preflight завершается до ввода пароля; Better Auth hash вычисляется локально; создание user+credential+audit выполняется одним атомарным SQL-скриптом с auth-lock, повторным admin-check и server-local timeout. Образ postgres:17-bookworm — одноразовый клиент через локальный Docker, не второй сервер. Пароль runtime — в PGPASSWORD, credential hash/SQL — только stdin; child stderr не печатается. После тайм-аута удаляется только свой container с точным UUID и совпавшей label, CA убирается; повтор записи не автоматический.

Новая `npm run cloud:bootstrap:check` прошла на настоящем выделенном staging: libpq, lotos_runtime, postgres, admins=0, authLockAvailable=true, accountCreated=false. Публичной CRM ещё нет, cloud-создание первого admin агент не запускал. Пул Vercel runtime уменьшен до одного connection на process; реальные latency/concurrency на Vercel ещё не проверены. План минимального выпуска: [SIMPLE_STAGING.md](SIMPLE_STAGING.md).

Приёмка упрощения: 312 Node + 8 native-bootstrap PostgreSQL + 36 auth + 90 domain = 446 отдельных проверок. На Test PostgreSQL подтверждены concurrent single-admin, отказ повторного создания, атомарный откат user/accounts при audit failure, безопасные SQL/psql-строки, минимальные table grants без schema-owner и вход созданного через libpq admin через прежний Prisma/Better Auth HTTP facade. Первоначально failed test cleanup попытался DELETE append-only audit; исправлен только reset disposable Test fixtures через TRUNCATE до отдельного auth-suite, production triggers не отключались. TypeScript/ESLint/форматирование/diff check/Gitleaks прошли. Cloud Webpack build с вымышленными endpoints/credentials прошёл; первый sandbox-прогон не смог разобрать child tsc --showConfig, разрешённый повтор завершился. Это не live HTTP/build deployment и не устранённый низкоуровневый корень локального timeout.

## Отказ bootstrap P2028: подтверждённая блокировка и предел диагноза

Повторный ручной bootstrap владельца вернул `BOOTSTRAP_P2028`. До повторной записи проверены счётчики: users/admins/accounts/bootstrap audit — 0. В PostgreSQL обнаружена одна оставшаяся `idle in transaction` сессия runtime-роли: последний запрос — вставка accounts, удерживается auth-management transaction lock, блокирующих её PID нет. Это незавершённая транзакция, а не подтверждённый администратор. Команда владельца уже завершилась; сессия адресно закрыта через `pg_terminate_backend` с проверкой точного PID, backend_start с микросекундами, текущей роли/БД, состояния, признака accounts INSERT и конкретного advisory lock. Незафиксированные вставки откатились; последующее чтение снова показало нулевые счётчики. Сохранённые данные/роли/миграции не удалялись.

Эта сессия объясняет блокировку последующих auth-management проверок, **но не устанавливает первопричину первого P2028**. Без CRM-кода обычный pg-клиент также иногда получает connect/query timeout через оба shared-порта. Синтетические ответы 4 КиБ и отдельные проверки всех трёх текущих DNS A-адресов также проходили; постоянная проблема размера ответа, конкретный плохой IP или DNS-корень не доказаны. Замена 6543 на 5432 сама по себе не подтверждена как решение. Роли/пароли/права не менялись; повторного cloud bootstrap агент не выполнял.

В bootstrap добавлен `SET LOCAL idle_in_transaction_session_timeout = '10s'` **до** auth-lock: сервер ограничивает ожидание клиента внутри этой транзакции, даже если клиентский rollback не дошёл. Session/role defaults не меняются, HTTP transaction limits не увеличиваются. Возвращаемые проекции user/account/audit ограничены необходимыми ID/username; хеш credentials не возвращается из INSERT. CLI фиксирует только allowlisted последний шаг и ограниченное числовое время при ошибке, без SQL/ввода/хешей. Hashing остаётся до транзакции, проверка единственного администратора и атомарность user+credential+audit сохранены. Это защита от найденного зависшего состояния и диагностическое уточнение, **не доказательство устранения локальных сетевых сбоев**.

Приёмка этой итерации: 308 Node-проверок, включая 8 целевых bootstrap-проверок (mock DB и subprocess без cloud-записей), и отдельно 36 auth-регрессий на disposable Test PostgreSQL; TypeScript/ESLint/форматирование/diff check и Gitleaks прошли. Первые live READ ONLY guard проверки через Node pg прерывались на connect/query timeout и не объявляются успешной приёмкой Prisma runtime.

Дополнительный контроль через штатный libpq/psql в одноразовом postgres:17-bookworm Docker с runtime-ролью и verify-full CA прошёл: BEGIN READ ONLY, SET LOCAL guard=10s, auth-lock доступен, users/accounts/bootstrap audit=0, ROLLBACK. Собственная оставшаяся READ ONLY probe-сессия адресно закрыта; свежий libpq-контроль показал 0 idle-in-transaction сессий. Это проверенный альтернативный транспорт для одноразовой операторской процедуры, не выполненное создание аккаунта и не приёмка HTTP Prisma runtime. Контейнеры --rm, пароль передавался в PGPASSWORD без вывода/аргументов, исходный CA readonly; private env и роли не менялись.

Полное приложение всё ещё не опубликовано, администратора нет. Следующая узкая альтернатива — ручной owner-bootstrap через libpq с теми же Better Auth hashing, transaction lock, проверкой отсутствия admin и атомарными user+credential+audit; адаптер ещё не реализован. Это не SQL-переинициализация и не замена Prisma runtime. Более сложный remote owner-bootstrap из Vercel потребует отдельного согласования передачи хеша первого пароля в build-задачу. Миграции повторять не нужно.

Основание защиты: [PostgreSQL idle-in-transaction timeout](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-IDLE-IN-TRANSACTION-SESSION-TIMEOUT), [Prisma v7 transaction limits](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions).

## Актуальное состояние после разрешённой миграции

Владелец отдельно разрешил передать настоящую Prisma-схему/9 SQL-миграций и миграционные credentials в одноразовую Vercel build-задачу и создать таблицы staging. **Штатный native Prisma 7.10.0 применил все 9 миграций.** Before-status: код 1, 9 неприменённых; deploy: код 0; after-status: код 0, schema up to date. Перед записью проверены exact endpoint/ref/CA, непривилегированные отдельные роли, пустая public-schema и SHA-256 engine/schema/SQL, взят отдельный advisory lock. При неизвестном результате автоматического повтора не было.

Сверка после применения: 27 public-таблиц (26 CRM и `_prisma_migrations`), 9 завершённых history-записей с исходными SHA-256, владелец таблиц lotos_migrator, runtime DML-права подтверждены, anon/authenticated не имеют SELECT/INSERT/UPDATE/DELETE. CRM-строк и аккаунтов, созданных job, — 0. Реальная `npm run cloud:verify` через Prisma/pg-клиент CRM прошла. Файлы/Blob не подключались. [Машиночитаемая запись приёмки](acceptance/supabase-staging-migration-2026-10-10.json).

Одноразовый operator deployment удалён; CLI list пуст. Локальный временный payload job (копии schema/SQL, manifest, скрипт, engine и project metadata) также удалён, оригиналы Prisma и private env сохранены. Само приложение не опубликовано; администратора владелец создаёт вручную через `cloud:bootstrap`. Миграционный пароль был build-only, не runtime CRM. Владелец намерен заменить тестовые пароли позднее; при замене обновляются private env и отдельно runtime deployment. Обычная сборка по-прежнему не запускает миграции. Рабочие Local/GAS/production не переключались, тарифы не менялись.

Это подтверждает рабочий путь native Prisma → Session pooler **из Vercel**, но не устанавливает внутренний корень локального зависания. Ниже сохранены первоначальная read-only диагностика и статус согласований на тот момент: «таблиц нет»/«согласие отсутствует» больше не описывают актуальную БД.

Позднее владелец сообщил о неудачном интерактивном bootstrap с логином/именем `admin`; старый CLI скрывал причину общей фразой. Read-only проверка после попытки: users/admins/credential accounts/bootstrap audit — 0. Проверка hashing вымышленного пароля прошла; read-only Prisma-транзакция с тем же auth-management lock после одного неудачного контрольного вызова прошла. Это не доказывает причину именно владельческой ошибки: пароль и его повтор агент не видел. CLI теперь выдаёт фиксированные безопасные коды валидации/соединения, делает preflight до ввода пароля и не объявляет подтверждённый commit неуспешным из-за cleanup. Сервис создания аккаунтов, hashing, права и транзакционная логика не менялись; агент администратора не создавал.

## Подтверждённый результат

Обычный `prisma migrate status` с **синтетической** схемой и одной фиктивной миграцией завершился в Vercel build за 5.5 секунды: код 1, миграционная таблица отсутствует, найдена одна неприменённая миграция. Это ожидаемый результат для пустой БД, не ошибка подключения. Фиктивная миграция не исполнялась.

Та же минимальная проверка в локальном Linux-окружении зависла на 30 секунд. Код CRM, настоящая схема и SQL-миграции приложения в этих проверках не участвовали. Использовалась только `lotos_runtime`; `DIRECT_URL` и пароль мигратора в Vercel не отправлялись.

| Проверка                                                 | Локально                                               | Vercel build                                               |
| -------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| SQL с CA/hostname, Transaction 6543                      | Один вызов — timeout 8 секунд; ранее успешные проверки | Успех в обоих build                                        |
| SQL с CA/hostname, Session 5432                          | Успех                                                  | Успех в обоих build                                        |
| Native Prisma can-connect, Session 5432                  | Успех, 0.9 секунды                                     | Успех в обоих build                                        |
| Native Prisma can-connect, Transaction 6543              | Не повторялся в этом сравнении                         | Timeout 15 секунд; для migrator этот режим не используется |
| Prisma migrate status, Session 5432, синтетическая схема | Timeout 30 секунд                                      | Ожидаемый код 1, 5.5 секунды                               |

Prisma CLI и native engine: 7.10.0, engine commit `0edf323efd1d98336f3f0a68684b56f689b900d3`. Probe SQL-драйвер: pg 8.16.3; это не полноценная приёмка runtime приложения с его pg 8.23.1. В обоих build `public` содержала 0 таблиц.

## Точка локального зависания и предел доказательств

Локальная трассировка фиксирует успешные `SELECT version()` и запрос проверки namespace `public` (122 и 127 мс). После них engine не продвигается; его TCP socket остаётся ESTABLISHED с нулевыми Send-Q/Recv-Q, отправленные байты подтверждены. Это не доказательство, что сеть исправна вообще, но не подтверждает гипотезу об обычной потере TCP-пакетов в этой точке.

Прямой JSON-RPC к engine, без Prisma JS CLI/обёртки CRM: `getDatabaseVersion` не дал ответа за 12 секунд после двух успешных SQL; отдельный `ensureConnectionValidity` ответил за 744 мс. Изменение TOKIO_WORKER_THREADS на 1/2 не устранило timeout minimal status.

Локальный контроль под официальным Node 22.23.2 (SHA-256 архива проверен) также не дал успешного status: вернул P1001 за 6 секунд. Это другой наблюдаемый сбой, не доказательство устранения зависания заменой Node. Vercel использовала Node 22.23.2, основной Local — 22.23.3. Диапазон engines согласован с проверяемой платформой; Local/CI/Docker остаются на 22.23.3.

Установлено: зависание воспроизводится без кода/схемы CRM, в локальном пути native engine → Supabase Session pooler. Из Vercel минимальный status работает. **Не установлено:** точная внутренняя причина в engine, Supavisor, ОС или их взаимодействии. Нельзя выдавать DNS/WSL/close/dispose за доказанный корень проблемы. Проверки runtime-ролью не доказывают, что deploy настоящих миграций под migrator обязательно пройдёт.

## Очистка и следующий шаг

После согласования Node engines выполнены 300 Node-проверок и TypeScript под официальной Node 22.23.2, lint изменённых тестов и локальная cloud Webpack-сборка с вымышленными endpoint/credentials. Первый прогон двух fixture-тестов упал из-за унаследованного DEBUG/RUST_LOG инструментальной среды; fixture теперь использует тот же очищенный child environment, что operator, и полный повтор прошёл. Это не объясняет исходное зависание владельца: его Prisma config загружался, а минимальные прямые native вызовы зависают и без этих переменных.

Владелец отдельно разрешил временную передачу runtime-пароля в Vercel build. Созданы только диагностические static deployments, без SQL-записей, аккаунтов CRM, HTTP-доступа к БД и платных услуг. Первый deployment стал production **отдельного staging-проекта** по правилам Vercel, второй был Preview. Оба удалены; повторный CLI list подтвердил отсутствие deployments. Постоянные Vercel env-переменные не создавались. Локальные временные probe-файлы удаляются после фиксации результатов; реальные конфигурации/БД сохранены.

Попытка проверки с настоящими приватными файлами Prisma была заблокирована проверкой безопасности **до upload**. Вместо неё использована синтетическая схема. Отдельное согласие на отправку настоящей схемы/миграций и миграционного credentials в Vercel пока отсутствует.

По завершении диагностики локальные временные probe-файлы, загруженный контрольный Node и оставшийся после прерванного теста временный CA удалены. Рабочие env-файлы, установленный Local Node, оригинальная Prisma-схема/миграции и БД сохранены. Итоговая проверка Git history и неигнорируемых исходников Gitleaks прошла; приватные env в этот scan не копируются.

Следующий проверяемый шаг: отдельный ручной migration job из среды Vercel — сначала `migrate status` под миграционной ролью, затем при ожидаемой пустой схеме `migrate deploy` настоящих версионированных миграций и сверка. Требуется явное согласие владельца на передачу в build настоящих файлов Prisma и `lotos_migrator` credentials и на создание таблиц staging. Миграционная роль не должна попадать в HTTP/runtime CRM; автоматические миграции обычного build не включаются. Job после выполнения удаляется. Ни backup/restore, ни публичная приёмка, ни production-переход этим не закрываются.

Документация: [Supabase Prisma — Session для migrator, Transaction для serverless](https://supabase.com/docs/guides/database/prisma), [Prisma migrate status](https://www.prisma.io/docs/orm/v7/reference/prisma-cli-reference#migrate-status), [Vercel build-only env и первый deployment](https://vercel.com/docs/cli/deploy).
