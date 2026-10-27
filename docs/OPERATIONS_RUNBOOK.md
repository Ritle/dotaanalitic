# Personal VPS deployment / emergency runbook

## Сервис

Ubuntu 24.04+, рекомендация 4 vCPU/8 GB/120 GB NVMe, Docker Compose. Сеть: только 80/443, SSH (ограничен владельцем). PostgreSQL и API — **только приватная сеть Docker**, без публикации портов. Шифрование TLS Caddy для домена `SITE_HOST`. Не использовать в production без реализации Auth (S0-03): current skeleton health is intentionally public, product routes not implemented.

## First deploy (только после S0-03 и прохода CI)

1. Создать и закоммитить реальный `pnpm-lock.yaml`, выполнить CI, тесты миграций, backup restore drill.
2. `cp .env.production.example .env.production`, заменить все пароли/домен и проверить `node scripts/preflight.mjs --production --strict`. Production Compose ожидает `DATABASE_URL` вида `postgresql://user:pass@postgres:5432/db`, не `localhost`.
3. `docker compose --env-file .env.production -f compose.production.yaml config` проверить **локально** (не публиковать результат со значениями секретов).
4. `docker compose --env-file .env.production -f compose.production.yaml up -d --build`; `docker compose ... ps`; запрос `https://SITE_HOST/health` → `status=ok`.
5. Owner создаётся только защищённой CLI-командой из S0-03; не seed-ить пароль миграцией.

## Backup

Перед большим изменением БД и ежедневно: `BACKUP_DIR=/mounted/offsite/backup ./scripts/backup-postgres.sh`. Это **файл SQL** в gzip, проверить `gzip -t`, копировать вне VPS. Не хранить единственную копию на том же диске. Хранение/ротацию задаёт владелец по доступному объёму и срокам.

## Restore

Восстанавливать **только** в изолированную staging database/новый volume. `RESTORE_ACK=RESTORE_TO_STAGING_ONLY ./scripts/restore-postgres.sh file.sql.gz`. Скрипт не очищает БД автоматически; восстановление в заполненную БД может завершиться ошибкой. Запуск на production-DB запрещён до процедуры согласованного downtime + проверенного плана.

## Upgrade / rollback

- Перед upgrade — SQL backup и фиксировать git commit/image tag.
- Миграции `001–005` не редактировать. Любой новый SQL — `006_...`.
- Не откатывать SQL физическим `DROP` без отдельного плана; менять приложение вперед-схемой.
- ML candidate не активируется автоматически; rollback model_version через registry с аудитом по контракту v4.

## Known deployment blockers v7

Нет проверенного `pnpm-lock.yaml`, не установлен Docker в среде генерации, не реализована Auth/API; production configs существуют, но **не проверены интеграционным запуском**.
