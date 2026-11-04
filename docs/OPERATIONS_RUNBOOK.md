# Personal VPS deployment / emergency runbook

## Сервис

Решение владельца2026-11-04: целевая площадка контейнерной проверки — отдельный Linux-хост. На текущем Windows-ПК продолжается native development. Адрес, доступ, private settings и доступность Docker на целевом хосте проверяются перед container smoke; отсутствие Docker на Windows не требует его установки здесь.

Ubuntu 24.04+, рекомендация 4 vCPU/8 GB/120 GB NVMe, Docker Compose. Сеть: только 80/443, SSH (ограничен владельцем). PostgreSQL и API — **только приватная сеть Docker**, без публикации портов. Шифрование TLS Caddy для домена `SITE_HOST`. S0-03 Auth реализован; production deployment остаётся заблокирован до реального Docker/CI/restore gate. Health публичен, продуктовые routes требуют owner session.

## First deploy (после прохода CI/Docker/restore gate)

Checkpoint2026-11-04: [production preflight](S4_03_V1_DEPLOYMENT_PREFLIGHT.md) проверяет согласованность env, Docker daemon и rendered services без вывода secrets. Локально production blocked: нет Docker и .env.production; container/remote CI не исполнялись. Windows frozen artifact требует отдельной проверки совместимости с Linux image. Фактический deploy не выполнялся.

Уточнение2026-11-03: [queue coverage](S4_01_V1_QUEUE_COVERAGE.md) исправил S4-SEC-03: текущий native verifier включает pg-boss и другие user schemas, отдельный78-entry working drill прошёл с queued data. Прежний65-entry evidence остаётся historical/public-only. До запуска восстановленных API/worker сессии должны быть отозваны и окружение проверено; сам native drill не запускает worker и удаляет только свою новую target DB. Реальный active-model/Docker/VPS release gate остаётся открытым.

1. Выполнить frozen install существующего registry lockfile, CI, тесты миграций, backup restore drill.
2. `cp .env.production.example .env.production`, заменить пароли/домен, задать постоянный AUTH_COOKIE_SECRET и при необходимости PANDASCORE_API_TOKEN; выполнить `pnpm preflight:production --json`. Не загружать development .env этой командой. WEB_ORIGIN должен быть HTTPS origin того же SITE_HOST, DATABASE_URL согласован с POSTGRES_* и host postgres:5432. Противоречащие exported variables блокируют проверку. --env-file выбирает другой private файл; secrets не выводятся. Проверка формата не подтверждает DNS/TLS или реальную provider authorization.
3. `docker compose --env-file .env.production -f compose.production.yaml config` проверить **локально** (не публиковать результат со значениями секретов).
4. `docker compose --env-file .env.production -f compose.production.yaml up -d --build`; `docker compose ... ps`; запрос `https://SITE_HOST/health` → `status=ok`.
5. Owner создаётся CLI: `docker compose --env-file .env.production -f compose.production.yaml run --rm api node apps/api/dist/modules/auth/owner-cli.js create` в интерактивном терминале; не seed-ить пароль миграцией. Аналогично `reset --login YOUR_LOGIN` отзывает все сессии. Задать случайный AUTH_COOKIE_SECRET >=32 символов и HTTPS WEB_ORIGIN; preflight проверяет оба условия.

## Backup

Для текущего Windows/localhost окружения доступен отдельный [native PostgreSQL16 drill](S4_V1_BACKUP_RESTORE.md): `pnpm backup:verify --pg-bin .tools/pgsql/bin --bundle .tools/v1-frozen-runtime`. Он восстанавливает свежую копию только в новую временную базу, сверяет данные/bundles и отзывает сессии в копии. Это не исполнение Docker-скриптов ниже и не offsite backup.

Перед большим изменением БД и ежедневно: `BACKUP_DIR=/mounted/offsite/backup ./scripts/backup-postgres.sh`. Это **файл SQL** в gzip, проверить `gzip -t`, копировать вне VPS. Не хранить единственную копию на том же диске. Хранение/ротацию задаёт владелец по доступному объёму и срокам.

## Restore

Восстанавливать **только** в изолированную staging database/новый volume. Legacy `scripts/restore-postgres.sh` пока использует production env/default project, а RESTORE_ACK не проверяет target isolation. До S4-03/V1-staging-restore-guard этот helper не использовать как процедуру восстановления: он не доказывает безопасный target. Native `backup:verify` проверяет восстановление только в свою новую временную БД; это отдельный исполненный путь, не переключение рабочего сервиса.

## Upgrade / rollback

- Перед upgrade — SQL backup и фиксировать git commit/image tag.
- Применённые миграции `001–035` не редактировать; сверять ledger SHA и golden001–005. Следующий SQL после текущего checkpoint —036+. Миграция035 добавила только current role hints/cache/quota; [настройка](S2_01_ROLE_PROFILES.md), ROLE_PROFILES_ENABLED по умолчанию false. Миграция013 оставляет старые recorded_at=NULL: это ожидаемый отказ owner-cohort, а не повод backfill-ить время ввода.
- Не откатывать SQL физическим `DROP` без отдельного плана; менять приложение вперед-схемой.
- ML candidate не активируется автоматически; rollback model_version через registry с аудитом по контракту v4.

## Current deployment blockers

Registry lockfile и localhost V1 реализованы/проверены; прежний generation-status «аналитические API planned» больше не актуален. Docker и production env на этой машине отсутствуют. Image build/runtime/HTTPS/remote CI, staging restore guard, Linux artifact compatibility и реальные model/release/active-model restore gates остаются открытыми. Local PG16/Node и fake Docker tests не заменяют эти проверки.

## Импорт одной карты (S0-02)

Локально: `pnpm worker:dev`, отдельно `pnpm ingest:enqueue --match-id MATCH_ID`; одноразово — `pnpm ingest:once --match-id MATCH_ID`. В собранном worker используется `node dist/cli.js work`, очередь находится в собственной PostgreSQL schema `pgboss`. Общие minute/day/month budgets задаются переменными OPENDOTA_*_BUDGET. Не обнулять quota row ради обхода лимита.

Failed queue — `opendota-map-import-failed`; причина выдаётся безопасным code. При `completed` с `output.status=deferred` работа перенесена, а не импортирована: следовать `nextJobId`, оставить worker запущенным. После bounded retry/deferral budget проверить причину и enqueue вручную. Conflict требует разбора evidence; старые receipts, outcomes и frozen snapshots не редактировать. [Контракты и live evidence](S0_02_INGESTION.md).
