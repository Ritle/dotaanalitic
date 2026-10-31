# Personal VPS deployment / emergency runbook

## Сервис

Ubuntu 24.04+, рекомендация 4 vCPU/8 GB/120 GB NVMe, Docker Compose. Сеть: только 80/443, SSH (ограничен владельцем). PostgreSQL и API — **только приватная сеть Docker**, без публикации портов. Шифрование TLS Caddy для домена `SITE_HOST`. S0-03 Auth реализован; production deployment остаётся заблокирован до реального Docker/CI/restore gate. Health публичен, продуктовые routes требуют owner session.

## First deploy (после прохода CI/Docker/restore gate)

1. Выполнить frozen install существующего registry lockfile, CI, тесты миграций, backup restore drill.
2. `cp .env.production.example .env.production`, заменить все пароли/домен и проверить `node scripts/preflight.mjs --production --strict`. Production Compose ожидает `DATABASE_URL` вида `postgresql://user:pass@postgres:5432/db`, не `localhost`.
3. `docker compose --env-file .env.production -f compose.production.yaml config` проверить **локально** (не публиковать результат со значениями секретов).
4. `docker compose --env-file .env.production -f compose.production.yaml up -d --build`; `docker compose ... ps`; запрос `https://SITE_HOST/health` → `status=ok`.
5. Owner создаётся CLI: `docker compose --env-file .env.production -f compose.production.yaml run --rm api node apps/api/dist/modules/auth/owner-cli.js create` в интерактивном терминале; не seed-ить пароль миграцией. Аналогично `reset --login YOUR_LOGIN` отзывает все сессии. Задать случайный AUTH_COOKIE_SECRET >=32 символов и HTTPS WEB_ORIGIN; preflight проверяет оба условия.

## Backup

Перед большим изменением БД и ежедневно: `BACKUP_DIR=/mounted/offsite/backup ./scripts/backup-postgres.sh`. Это **файл SQL** в gzip, проверить `gzip -t`, копировать вне VPS. Не хранить единственную копию на том же диске. Хранение/ротацию задаёт владелец по доступному объёму и срокам.

## Restore

Восстанавливать **только** в изолированную staging database/новый volume. `RESTORE_ACK=RESTORE_TO_STAGING_ONLY ./scripts/restore-postgres.sh file.sql.gz`. Скрипт не очищает БД автоматически; восстановление в заполненную БД может завершиться ошибкой. Запуск на production-DB запрещён до процедуры согласованного downtime + проверенного плана.

## Upgrade / rollback

- Перед upgrade — SQL backup и фиксировать git commit/image tag.
- Применённые миграции `001–013` не редактировать, `001–005` защищены golden. Следующий SQL — `014_...`. Миграция 013 оставляет старые recorded_at=NULL: это ожидаемый отказ owner-cohort, а не повод backfill-ить время ввода.
- Не откатывать SQL физическим `DROP` без отдельного плана; менять приложение вперед-схемой.
- ML candidate не активируется автоматически; rollback model_version через registry с аудитом по контракту v4.

## Known deployment blockers v7

Registry lockfile создан в S0-00 и обновлён/проверен frozen install в S0-02/S0-03. Docker отсутствует, Auth реализован, аналитические API ещё planned; production configs, включая worker, **не проверены контейнерным запуском**. Локальные PG16/Node интеграции не заменяют deploy/restore gate.

## Импорт одной карты (S0-02)

Локально: `pnpm worker:dev`, отдельно `pnpm ingest:enqueue --match-id MATCH_ID`; одноразово — `pnpm ingest:once --match-id MATCH_ID`. В собранном worker используется `node dist/cli.js work`, очередь находится в собственной PostgreSQL schema `pgboss`. Общие minute/day/month budgets задаются переменными OPENDOTA_*_BUDGET. Не обнулять quota row ради обхода лимита.

Failed queue — `opendota-map-import-failed`; причина выдаётся безопасным code. При `completed` с `output.status=deferred` работа перенесена, а не импортирована: следовать `nextJobId`, оставить worker запущенным. После bounded retry/deferral budget проверить причину и enqueue вручную. Conflict требует разбора evidence; старые receipts, outcomes и frozen snapshots не редактировать. [Контракты и live evidence](S0_02_INGESTION.md).
