# Текущее состояние репозитория — Codex handoff

**Обновлено:** 2026-10-31. S0-00/DX-00, S0-01, S0-02 + связанный S0-10 выполнены локально. **Функциональный MVP ещё не готов.** Рабочий Git checkout находится в `dotaanalitic`, родительская копия starter не является текущим репозиторием.

## Реально присутствует

- Vue 3 техническая оболочка и Fastify `/health`; продуктовые страницы/API и Auth ещё не реализованы.
- PostgreSQL 16.15 native localhost/SCRAM; SQL 001–007 применены, повтор — 7 SKIP. Миграции 001–006 не редактировались; 001–005 соответствуют golden.
- Shared `@dota/db` (pg/Kysely 0.28.18), `@dota/ingestion` (OpenDota client, normalization, provenance, quality, global persistent quotas), `@dota/worker` (pg-boss 12.38.0, separate own schema).
- CLI enqueue/once/worker, bounded retries и atomic durable Retry-After deferral, per-map SQL lock/idempotency, append-only source/raw/quality evidence. Conflict сохраняет старые факты и исключает карту из pro-only выборки.
- Raw draft/final heroes независимы; 0/11/12 picks сохранены, verified timeline не выдумывается. Patch/first-pick/known-at/roles остаются unknown без доказательств. Canonical players только через verified account links, не nickname/current roster flag.
- Live S0-01: 20-map recent coverage + bounded provider spike; [исторический отчёт](S0_01_PROVIDER_SPIKE.md).
- Live S0-02: карта `9069021061` дважды через очередь, одна карта/10 slots/revision 1, repeat duplicate; canonical IDs 0/10, patch/known-as-of не подтверждены. [Отчёт](S0_02_INGESTION.md), [evidence](evidence/s0-02-live-import.json).
- Последний PASS S0-02: frozen install/typecheck/build; 64 unit + 16 ingestion/queue DB + 4 baseline DB + 10 Node tests; migrations/checksums, docs links, health smoke. Integration synthetic data остаются во временных отдельных БД с cleanup.
- S0-00 ранее: 1 Chromium E2E/visual smoke, 6 Python tests, 12 Python↔JS parity comparisons. В S0-02 не повторялись; demo остаётся `deployable:false`, `synthetic_only:true`.

## Ограничения и команды

- Root `pnpm dev`, `worker:dev`, `ingest:enqueue`, `ingest:once`, `provider:spike`, `provider:audit` автоматически собирают shared dependencies. После shared source изменений перезапускать worker. `pnpm test:ingestion` требует CREATEDB и PG16.
- Provider defaults: 45 RPM / 2000 day / 45000 month, PostgreSQL counter и UTC reset; `.env`/`.tools` игнорируются. Live audit теперь требует DB + migration 007 и использует общий quota path.
- Lockfile обновлён pnpm 10.19.0 и проверен frozen install. Испытаны Node 22.15.0; Python 3.11.9 в `.venv` только в S0-00.
- Docker/Compose отсутствуют. Worker/API Dockerfiles и production Compose подготовлены, контейнерный runtime, restore drill и remote GitHub Actions не запускались. PG проверен нативно. Push/deploy не выполнялись.
- Нет Auth, bulk/backfill scheduler, production training/model activation или прогнозов. `accepted` import не равен model eligibility. Состав после матча не доказывает доступность до старта. S0-08/09 и исторические/ML gates открыты.

## Следующая задача

**S0-03 [P0] Личный доступ.** Начать с IMPLEMENTATION_PLAN, Auth разделов API/engineering patterns и users/sessions схемы. Единственный владелец через CLI, Argon2id, opaque DB sessions, cookie/CSRF/rate limit, tests 401/403/expiry; без публичной регистрации. Рекомендуемая модель: **GPT-6.1 Sol · High**.
