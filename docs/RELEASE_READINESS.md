# Проверка готовности первого выпуска — 9 октября 2026 года

Объём подтверждён владельцем: [RELEASE_SCOPE.md](RELEASE_SCOPE.md). Этот отчёт фиксирует сделанное в текущем проходе и реальные зависимости. Он не объявляет публичный deployment, постоянный импорт или переход выполненными.

| Шаг | Результат | Что необходимо дальше |
| --- | --- | --- |
| 1. Объём выпуска | Подтверждён текущий реализованный объём; исключения и поведение записаны | Расширения относятся к следующим выпускам |
| 2. Постоянный тестовый импорт | Local read-only: 9 миграций, 0 active admin, 0 клиентов, 0 import batches | Ручной bootstrap владельца, свежая копия, apply и независимый verify |
| 3. Cloud PostgreSQL | Supabase-профиль реализован; exact ref/endpoint, Session pooler, CA, отдельный migrator, SQL-роли и шаблон | Подключить отдельный Supabase-проект, настроить роли/secrets, выполнить реальные migrate/verify |
| 4. Публичный staging | Production cloud build прошёл на вымышленных параметрах; оба кабинета прошли локальный Chromium | Подключить Vercel, точный staging-проект и APP_URL, deployment и публичная приёмка |
| 5. Копии/alerts/нагрузка | Локальный SQL+файловый restore и измерения пройдены | Задать внешнее хранилище/канал, согласовать RPO/RTO; реальные offsite job/restore и sustained HTTP |
| 6. Переход и передача | Runbook подготовлен | Успешная публичная приёмка, рабочая площадка/данные, окно перехода и финальная сверка |

## Самостоятельно выполненные проверки

Прогоны не суммируются с прежними 469/403 или промежуточными целевыми тестами.

| Набор | Passed |
| --- | ---: |
| Полный Node-набор, включая Supabase/TLS/Prisma | 296 |
| PostgreSQL foundation/миграции | 28 |
| PostgreSQL auth | 36 |
| PostgreSQL domain/import/recovery/documents | 90 |
| Operations/performance/restore/SQL-роли | 8 |
| Настоящий Next HTTP + Chromium | 24 |
| **Итого** | **482** |

TypeScript, ESLint, форматирование и Gitleaks истории/current non-ignored файлов прошли. Production Webpack build выполнен в Supabase staging-профиле без квитанций, с вымышленными endpoint и временным тестовым CA, без подключения к настоящей managed-БД.

Supabase SQL setup проверен на отдельном одноразовом PostgreSQL-кластере под operator-role без superuser. Runtime не выполняет DDL, backup не пишет, anon/authenticated не читают CRM; это не проверка реальных настроек панели Supabase.

## Измерения

Внутрипроцессный router + настоящий PostgreSQL TCP; 12 измерений каждого сценария, 5 000 клиентов, 1 000 занятий, roster 100, 500 старых отсутствий.

| Операция | p95, мс | Максимум SQL-запросов |
| --- | ---: | ---: |
| Расписание 1 000 занятий | 197.60 | 7 |
| Состав 100 учеников | 54.24 | 12 |
| Атомарные 20 отметок | 367.13 | 120 |
| История с аудитом | 82.50 | 17 |

Реальное локальное восстановление отдельной test-БД: проверены checksum, вход, учёт, байты квитанции и отказ повреждённого файла. offsiteCopyVerified=false и publicHttpsVerified=false. Артефакты: ignored .artifacts/performance-latest.json и .artifacts/restore-latest.json. Эти времена не устанавливают публичный SLO или длительный soak.

## Актуальный audit

После явного согласия владельца выполнен npm audit: runtime/omit-dev — 0 advisory, full — 5 high / 0 critical. Корневая проблема: braces <=3.0.3, GHSA-vfj7-8cjw-p6xm (stack exhaustion на глубоко вложенных шаблонах). Registry публикует latest 3.0.3; предлагаемый npm downgrade eslint-config-next до 14.2.35 не применён. Остальные affected-пакеты — ESLint/fast-glob/micromatch toolchain.

Остаточный риск не считается принятым автоматически. Для публичного выпуска нужен совместимый fix либо отдельная зафиксированная оценка и ограниченное принятие риска владельцем. Текущий source/build проверен, но это не обещание отсутствия любых уязвимостей.

## Следующие действия владельца

- В WSL под Node 22: npm run auth:bootstrap:local. Пароль вводится только интерактивно.
- Подключить Vercel и Supabase; указать отдельные staging-проекты. В текущей сессии эти подключения не подтверждены, browser surfaces отсутствуют, .env.vercel.staging.local не найден.
- Указать внешний backup destination, канал alerts и цели RPO/RTO. Предложение 24 часа / 4 часа остаётся предложением.

После появления этих данных агент может продолжить фактический импорт, подключение и публичную приёмку по [SUPABASE_STAGING.md](SUPABASE_STAGING.md), [TEST_IMPORT_RUNBOOK.md](TEST_IMPORT_RUNBOOK.md), [CUTOVER_RUNBOOK.md](CUTOVER_RUNBOOK.md).
