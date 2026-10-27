# Инфраструктура, безопасность, тестирование и поддержка

## 1. Один VPS без лишних служб

Рекомендованный ориентир для персонального MVP: **4 vCPU / 8 GB RAM / 100–120 GB NVMe**, Ubuntu 24.04 LTS, контейнеры/процессы web (static), API, worker, PostgreSQL. Python training — локальный batch CLI в worker/offline режиме с concurrency=1; отдельный GPU и Redis не нужны. Объём памяти и диска — гипотеза до реальных профилей 30k+ карт.

**Development:** Compose поднимает PostgreSQL, API/Web работают нативно (`pnpm dev`). **Production:** nginx/Caddy HTTPS same-origin, API private, worker отдельно, Postgres volume, no DB public port; `pg-boss` таблицы создавать/управлять строго по его supported migration/setup workflow. Не смешивать `pg-boss` internal schema migrations с ручными `packages/db/migrations/001..005`.

## 2. Secrets and owner auth

- `OWNER` создаётся вручную CLI, password hash `argon2id`, не в репозитории и не в stdout, запрет публичной регистрации.
- Сессия: криптографически случайный непрозрачный token; в cookie `__Host-session` (`HttpOnly`, `Secure`, `SameSite=Lax/Strict`, `Path=/`, без `Domain`); в DB хэш токена, дата истечения/отзыва. TLS termination / proxy trust установить безопасно.
- CSRF на state-changing cookie запросы, rate limit на login, login events без disclosure username/password/token.
- OpenDota/STRATZ ключи только на сервере; `.env` и artifacts не попадают в git. Whitelist разрешённых доменов провайдера, no arbitrary URL fetch (SSRF).
- `@fastify/secure-session` — **альтернативный** механизм, а не параллельная сессия: starter уже содержит server-side `auth_sessions`, поэтому предпочтительнее opaque DB sessions + `@fastify/cookie`.

## 3. CI pipeline & quality gates

```text
pnpm install --frozen-lockfile
  -> typecheck
  -> lint (если добавлен)
  -> Vitest unit/route tests
  -> PostgreSQL integration (start empty DB, apply 001..006, assert constraints)
  -> Vue build / API build
  -> Playwright smoke (when UI ready)
  -> ML offline tests + TS parity (when model ready)
```

- На первом bootstrap допускается `pnpm install`, затем commit lockfile. Сборка должна проходить на чистом clone без `.env` prod secrets.
- Отдельные тесты `migration checksum immutability`, second migration run no-op, fresh DB startup, invalid/partial provider fixtures, ten hero uniqueness, idempotency, no past prediction mutation.
- Security/API: 401 unauthenticated, 403 CSRF, 409 stale revision, 202 queued sync, upstream failures not 500 fake numbers.
- ML gates обязательны до любого `status=ready` с реальной вероятностью; до того `status=unavailable`. «Модель обучилась» недостаточно для feature completion.

## 4. Performance and observability

| Показатель | Начальная цель/мониторинг |
|---|---|
| API read latency | <1 c для типовых сохранённых отчётов на локальной БД — целевой SLO после профилирования, не обещание |
| Training runtime | Offline batch; ограничить CPU/RAM одним обучением, monitor elapsed/peak RSS |
| Import backlog | Age of oldest job, queue depth, error count, 429 rates |
| DB | Connections, disk usage, slow queries via pg_stat_statements, VACUUM/bloat |
| Data freshness | per provider latest successful sync, patch registry update age, partial map count |
| Prediction quality | Brier/LogLoss, coverage/abstain, calibration, patch/roster slice, prospective only |

Сначала Pino structured logging, request/job correlation IDs, health/live и readiness (DB ping). Сложные Prometheus/Grafana/OTel — P1 при появлении необходимости. Никакого логирования raw secrets, session cookie и приватных user input dumps.

## 5. Backups and restore (P0)

- Ежедневный `pg_dump` + хранение вне VPS минимум 7 версий (настроить согласно требованиям владельца), опционально WAL backup при росте данных.
- Копировать зашифрованные manifest/model artifacts вместе с DB snapshots; SHA в registry позволяет обнаружить несоответствие.
- Проверять **восстановление** на отдельной тестовой БД, в том числе миграции, owner session revocation, восстановление активной model version и связанной checksum.
- `docker compose down -v` опасен: удаляет DB volume; явно предупреждать Codex.

## 6. Rollout / rollback

- DB migrations forward-only, перед изменением schema backup; проверка на копии базы.
- Deployment API/worker единым совместимым feature version, graceful shutdown worker; no unbounded import retry storms.
- Старые immutable prediction snapshots сохраняются независимо от новой версии модели; rollback model registry — транзакция с event; rollback кода должен сохранять чтение старых nullable schemas.
- Никаких сбросов рабочей БД ради поправки фикстур.

## 7. Эксплуатационные границы для первой версии

- ~30k pro-карт × 10 участников — небольшая структурированная БД, но крупные JSON из реплеев надо контролировать отдельно.
- Перед шардированием, Redis или очередями вне PostgreSQL сначала снять CPU/memory/pg query profiles.
- Первоначальная загрузка зависит от квот и полноты OpenDota. Ограничение скорости не обходить большим числом IP/ключей.
