# Этап 12: self-hosted staging и восстановление

9 октября 2026 года. Это подготовленная операторская процедура, **не уже выполненный публичный deployment**. Нужны VPS/домен и доступ оператора, отдельное разрешение на создание staging-аккаунтов, выбранное внешнее хранилище, цели RPO/RTO и обработчик alerts. Production не запускаем автоматически; реальные XLSX/Google данные в staging не копируем.

Позднее 9 октября владелец выбрал временный Vercel до аренды своего VPS. Эта self-hosted процедура сохраняется для будущего сервера; Docker Compose нельзя считать уже совместимым Vercel deployment. Отдельный план, ограничения и неготовые адаптеры: [VERCEL_STAGING.md](VERCEL_STAGING.md). Создание Local-администратора агентом отклонено, владелец выполняет bootstrap вручную.

## Что проверено локально

- Собраны runtime/migrator Docker images; runtime реально запускается под UID 10001 с read-only root, без сети, без env и XLSX в образе. Node/Caddy/PostgreSQL образы закреплены version + digest, зависимости — lockfile. Не запускаем `next dev` на публичном VPS.
- `npm run test:infra:config`: staging/production Compose config успешно разобран с **вымышленными** значениями, без создания сервисов. Caddy config проверен настоящим `caddy validate` без сети.
- Runtime SQL-роль и backup-роль проверены реальным init-скриптом и восстановлением схемы на отдельной временной БД **в Test-контейнере**, а не на VPS. Ни DDL/отключение audit/TRUNCATE приложению, ни DELETE backup-роли не разрешены.
- SQL и приватные документы действительно восстановлены на отдельную Test-БД/каталог: вход, аудит, точные байты файла, отказ при порче. В последнем прогоне подготовка маленького bundle ~522 мс, restore с приложением ~1 304 мс. Это **не production RTO** и не внешняя копия.

Подробности тестов/рисков: [SECURITY_PERFORMANCE.md](SECURITY_PERFORMANCE.md).

## Топология и секреты

`infra/compose.self-hosted.yaml` использует отдельный project name для каждого окружения. Единственные public ports — Caddy 80/TCP, 443/TCP и 443/UDP; app:3000 и PostgreSQL:5432 **не публикуются**. Caddy не видит database/documents volumes; backend network internal. Он первым принимает интернет-трафик и перезаписывает `X-Lotos-Client-IP` реальным TCP peer. Не включать CDN/proxy перед ним без отдельной проверки trusted-proxy правил; для первого выпуска DNS-only.

App — non-root, no-new-privileges, cap_drop ALL, readonly root, ограниченные tmpfs/память, остановка с drain до 30 секунд. Документы доступны только защищённому API, не `file_server`. Init-job создаёт **только свой volume** с каталогами 0700 и owner UID 10001. База, документы, Caddy data/config и пути backup разделены по Compose project/APP_ENV.

Новый пустой database volume создаёт роли через `infra/postgres/001-roles.sh`: owner отдельно, migrator владеет схемой, runtime без DDL, backup только SELECT. Скрипт не является ротацией паролей существующей базы: изменение env не меняет уже созданные роли. Никогда не удалять volume для «исправления конфигурации».

Приватный root-owned `.env.staging.local` (0600, вне Git) собираем по `infra/env/.env.staging.example`. Для production — **другой** файл/пароли/project/volumes/repository. Owner/runtime/migrator/backup/auth secret должны быть разными 64-hex значениями. URL-credentials должны совпадать с соответствующими password-полями; `APP_URL` строго HTTPS и совпадает с `CRM_DOMAIN`. Регистрация выключена. `APP_IMAGE`/`MIGRATOR_IMAGE` — immutable digest references или локальные полные `sha256:` IDs, не latest.

Секреты не передаются Docker build ARG и не становятся `NEXT_PUBLIC_`. Env, auth secret и recovery credentials нужно отдельно сохранять в выбранном приватном secret store/password manager: SQL dump не содержит всей конфигурации и не заменяет её. Не выводить `docker compose config` с реальными значениями — только `config --quiet`.

## Порядок после согласования VPS/домена

1. Выбрать проверенную ревизию/артефакты. Не деплоить грязный working tree и не смешивать staging с production. VPS должен иметь Docker Compose, Node 22 для операторского preflight и restic для выбранного offsite repository; версии/обновления проверяются отдельно.
2. Создать private env и host backup directory `/var/lib/lotos-crm/backups/staging`, owner root, режим 0700. Проверить `npm run deploy:check -- staging` под тем же оператором/root, который владеет env. Пока реальные значения не заполнены, preflight должен отказывать.
3. Проверить A/AAAA домена, маршрутизацию и firewall у провайдера: открыть только согласованные public Caddy/SSH порты. База не должна быть доступна извне. Не копировать персональные данные или production secret в staging.
4. Собрать/получить images, записать их digests/IDs в env. Локальные проверочные теги `stage11-local-check` не являются production release reference.
5. Поднять db и documents-init, выполнить миграции отдельным migrator. Не применять Prisma Local-config на сервере и не выдавать runtime migrator/owner пароль.
6. Поднять app/Caddy, проверить внутренний readiness, реальный публичный HTTPS/liveness, headers, Secure cookies и отсутствие публичного ready/DB/app портов.
7. По отдельно подтверждённой процедуре создать staging-владельца и вымышленных тренеров/клиентов; провести оба кабинета и реальные потерянные ответы/конфликты. Local-only bootstrap в эти условия автоматически не расширяется.
8. Настроить offsite encryption/repository, расписание и alerts, выполнить clean-room restore с этого repository. Только затем дать людям публичную тестовую ссылку и зафиксировать пользовательскую приёмку.

Пример команд **для оператора на выбранном VPS**, не разрешение агенту выполнить их сейчас:

```bash
npm run deploy:check -- staging
docker compose --project-name lotos-crm-staging --env-file .env.staging.local -f infra/compose.self-hosted.yaml config --quiet
docker compose --project-name lotos-crm-staging --env-file .env.staging.local -f infra/compose.self-hosted.yaml up -d --wait db documents-init
docker compose --project-name lotos-crm-staging --env-file .env.staging.local -f infra/compose.self-hosted.yaml --profile ops run --rm migrate
docker compose --project-name lotos-crm-staging --env-file .env.staging.local -f infra/compose.self-hosted.yaml up -d --wait app caddy
```

При ошибке миграции/health не продолжать переключение и не делать reset/drop. Миграции применяет `prisma.deploy.config.ts`: явное staging/production, private db, отдельный migrator. Для отката после новых записей старый image/schema не включаем вслепую: нужна совместимость и план данных.

## Копии: не только volume

SQL dump и файловый snapshot **не одна транзакция**. `infra/ops/backup-host.sh` проверяет preflight/приватный restic password file, фиксирует работающий app, ставит recovery trap **до** остановки, gracefully останавливает writer, создаёт SQL+tar bundle, возобновляет app и только потом загружает внешнюю копию. Не запускать параллельно CLI-import/migrate/admin writes; других writer/worker в этой схеме пока нет.

`backup-bundle.sh` запускается readonly SQL-ролью, документы монтируются ro. Umask 077, каталог bundle 0700, checksum для SQL/tar, COMPLETE только после успеха обоих snapshot. Tar сохраняет приватные права/UID; Node fs.cp без настройки создаёт каталоги 0755 и не подходит как production restore-процедура. Не восстанавливать непроверенные чужие архивы, symlinks/path traversal или incomplete bundles.

`infra/systemd/lotos-backup@.service/.timer` — **не включённые** шаблоны. Предложен ежедневный запуск с jitter; это ещё не утверждённое RPO «строго ≤24 часов». Более частое резервирование/PITR и окна краткого downtime определяются после ответа владельца. Для каждой environment — свой `/etc/lotos/backup-ENV.env` и root-owned 0400/0600 restic password file. Repository только вне VPS (reviewed SFTP/private object storage); локальный volume не считается offsite.

После успешной загрузки есть частичная read-data проверка restic; это не полноценный restore всей базы. Автоматического prune/удаления uncertain документов или старых копий нет. Retention/очистку включаем только после проверенного восстановления и согласованных сроков.

Для SFTP заранее настроить отдельные SSH identity/known_hosts через системную конфигурацию и приватные файлы в `/etc/lotos`: systemd `ProtectHome=true` намеренно скрывает домашние каталоги. Не рассчитывать на интерактивный пароль, агент пользователя или ключ в `/root/.ssh`; проверять non-interactive загрузку под пользователем сервиса. Для object storage — отдельные ограниченные provider credentials. Эти настройки ещё не выполнялись.

## Мониторинг и восстановление

`infra/ops/monitor.sh` — read-only internal readiness, free backup disk >1 GiB и свежий локальный COMPLETE marker. Он **не доказывает** свежесть внешней копии. Не настроены получатель alerts/внешний uptime probe и уведомления об ошибке systemd/backup: до приёмки выбрать канал и проверить доставку контрольной ошибки. Docker health status сам по себе не перезапускает unhealthy-процесс; restart policy помогает при выходе процесса, не заменяет операторскую реакцию.

Clean-room restore проверяем вне рабочей БД/volumes:

1. Восстановить выбранный **offsite** snapshot в новый приватный каталог, проверить COMPLETE/checksums/environment/revision.
2. Проверить список tar entries и отсутствие symlinks/absolutes/`..`; развернуть документы с владельцем UID 10001, каталогами 0700 и файлами 0600. Не менять оригиналы.
3. Создать отдельную новую БД/роли и восстановить SQL с exit-on-error, без ownership/ACL чужого окружения. Применить проверенные least-privilege grants, не runtime-superuser.
4. Подключить тот же совместимый release image и восстановленный auth secret на отдельном приватном адресе; проверить миграции, вход, оба кабинета, количественный аудит, платежи/историю и реальные байты квитанций.
5. Зафиксировать размер/скорость, время загрузки копии+подготовки хоста+restore+приёмки и фактическую потерю данных. Это полное измерение RTO/RPO, не только время pg_restore.
6. Проводить повторные упражнения, в том числе corruption/missing-file cases. Переключать рабочий трафик только отдельным согласованным решением.

Один VPS остаётся точкой отказа. Обещание — обнаруживаемые сбои и проверенное восстановление, не непрерывная доступность при любой аварии. Публичный staging пока не закрыт: VPS, домен, offsite destination, RPO/RTO, alerts, исходные staging-аккаунты и остаточные dependency-risk решения ждут владельца.

Основания: [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [PostgreSQL SQL dump](https://www.postgresql.org/docs/17/backup-dump.html). Резервирование/внешние ключи не заменяют проверку бизнес-правил приложения.
