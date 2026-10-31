# Текущее состояние репозитория — Codex handoff

**Обновлено:** 2026-10-31. S0-00/DX-00, S0-01, S0-02 + S0-10, S0-03 и **S0-04** выполнены локально. **Функциональный MVP ещё не готов.** Рабочий Git checkout — `dotaanalitic`; родительский starter не редактировать.

## Реально присутствует

- Vue login/logout/router guard и личная оболочка; Fastify health/auth, CLI owner provisioning/reset, Argon2id, hash-only opaque sessions, CSRF и per-IP/global PG login budgets. Owner в рабочей БД не создавался автоматически. [S0-03](S0_03_OWNER_AUTH.md).
- Import одной карты через durable pg-boss worker: idempotency, immutable receipts/raw/quality, global quotas/Retry-After, canonical links only when verified. Raw 0/11/12 picks сохранены; unknown patch/known_at/roles не угадываются. [S0-02](S0_02_INGESTION.md).
- **S0-04:** `@dota/contracts` temporal schemas, `@dota/db` MatchContextRepository + pure strict-asof-v1 resolver. Source/event/known/fetched/stage/availability и роли сохраняются независимо. Immutable typed `context.*` observations не смешиваются с raw provider facts; no outcome/telemetry whitelist. Conflicts, unknowns, late knowledge и post-draft поля в pre-match дают недоступность.
- Evidence insert + data_revision atomic, concurrent retries deduplicated; corrected proof appends, no UPDATE/DELETE. SQL/TS typed timestamps требуют UTC millisecond precision, чтобы микросекунды не округлялись в cutoff. [Контракт S0-04](S0_04_TEMPORAL_CONTEXT.md).
- PostgreSQL 16.15 native localhost/SCRAM; **001–009 применены**, повтор 9 SKIP. Исторические 001–008 не менялись; 001–005 golden совпадают. Следующая миграция **010+**.
- Node 22.15.0 / pnpm 10.19.0, pg/Kysely 0.28.18, pg-boss 12.38.0. Contracts/db/ingestion compiled dist/declarations; root shared:build строит зависимости топологически. Lockfile обновлён pnpm только для db→contracts/vitest; версии external dependencies не менялись.

## Проверено

- S0-04 PASS: frozen install/typecheck/build, **82 unit + 40 DB/integration** (temporal 9, ingestion/queue 16, auth 11, baseline 4), **10 Node fixtures**; migration checksums/doc links/git diff. Compiled Node repository прочитал сохранённую реальную карту: ни одного выдуманного as-of факта.
- Live S0-01: recent 20-map coverage ([отчёт](S0_01_PROVIDER_SPIKE.md)). S0-02: карта 9069021061 дважды импортирована через очередь, одна карта/10 slots/revision 1; canonical IDs 0/10, historic availability неизвестна. S0-04 новых provider-запросов не делал.
- S0-03 ранее: 2 Chromium E2E + mobile/desktop visual inspection; S0-00 ранее: 6 Python tests / 12 parity comparisons. В S0-04 UI/E2E/Python не менялись и не повторялись.
- Tests synthetic only in separate temporary databases; рабочая БД не получает synthetic contexts/owners. Demo ML остаётся synthetic_only/deployable:false; production models не создавались.

## Запуск и ограничения

- Frozen install → `pnpm db:migrate` → `pnpm owner:create` в локальном терминале → `pnpm dev`. Web открывать точно по WEB_ORIGIN (обычно http://localhost:5173), не менять hostname без настройки.
- Production: HTTPS WEB_ORIGIN + AUTH_COOKIE_SECRET >=32 random characters. Dev loopback без secret использует process-local CSRF signing key; DB session остаётся, reload/me обновляет CSRF.
- `pnpm test:temporal`, `test:auth`, `test:ingestion`, `test:e2e` требуют PG16/CREATEDB. PG сейчас доступен; API/Vite не оставлены работающими. Если PG остановлен, проверить существующий .tools/pgsql/.tools/pgdata; не пересоздавать кластер.
- Windows sandbox может блокировать child processes (EPERM); разрешённые повторы прошли. Frozen install выполнялся в том же окружении, где pnpm восстановил modules.
- Docker/Compose отсутствуют: container builds/TLS/restore/remote GitHub Actions не выполнены. Push/deploy не выполнялись.
- Нет аналитических страниц/API, identity review, полного match/patch/hero-eligibility resolver, frozen dataset builder/production training/activation. Context resolved ≠ model eligibility; partial lineup/role estimates не становятся доказанной десяткой. Strict evidence не закрывает conditional/live cohort и исторические coverage gates S0-08/09.

## Следующая задача

**S0-05 [P0] Identity & lineup integrity.** Читать IDENTITY_AND_DATA_QUALITY + ROSTER_CONTINUITY и текущие player_external_accounts/aliases/role observations; сохранить карьеру через трансферы, проверять identity/lineup/roles, не склеивать по nickname/current-team. Использовать S0-04 evidence boundary; не внедрять S0-06 patch rules или S3 feature builder заранее. Рекомендуемая модель: **GPT-6 Astra · High**.
