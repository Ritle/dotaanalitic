# Текущее состояние репозитория — Codex handoff

**Обновлено:** 2026-10-31. S0-00/DX-00, S0-01, S0-02 + S0-10, S0-03, S0-04 и **S0-05** выполнены локально. **Функциональный MVP ещё не готов.** Рабочий Git checkout — `dotaanalitic`; родительский starter не редактировать.

## Реально присутствует

- Vue login/logout/router guard и личная оболочка; Fastify health/auth, CLI owner provisioning/reset, Argon2id, opaque sessions/CSRF/rate limits. Owner в рабочей БД автоматически не создавался. [S0-03](S0_03_OWNER_AUTH.md).
- Import одной карты через durable pg-boss worker: quotas/retries, idempotency, immutable receipts/raw/quality. Raw 0/11/12 picks сохраняются; patch/historical known_at/roles не угадываются. [S0-02](S0_02_INGESTION.md).
- S0-04: MatchContextRepository + pure strict-asof-v1, separate event/known/fetched, typed `context.*` observations, stage/cutoff/conflict gates, immutable provenance. [Контракт](S0_04_TEMPORAL_CONTEXT.md).
- **S0-05:** identity/alias evidence ledger + IdentityRepository, pure resolveIdentity/resolveLineup. Importer использует общий verified Steam32 resolver, normalizer `opendota-map-v2-identity`, сохраняет proof IDs/status. Совпадение nickname/alias не объединяет людей; conflicting providers/rejected verified proof дают unknown identity/conflict.
- `historyForPlayers` — repeatable-read retrospective participation по source accounts и identity evidence на cutoff, completed pro only, без фильтра организации. Возвращает map/identity revisions, counts/null для unknown, complete native fives и warnings. Не использовать stale `match_players.player_id` как sufficient identity gate.
- `lineupAsOf` использует только S0-04 verified context, роли проверяются отдельно. Estimated или low-confidence role → rolePos:null с сохранением roleEvidence; no current-members/array-index role assignment. [Контракт S0-05](S0_05_IDENTITY_LINEUP.md).
- PostgreSQL 16.15 native localhost/SCRAM; **001–010 применены**, повтор 10 SKIP. 001–009 не менялись; golden 001–005 совпадают. Следующая миграция **011+**.
- Node 22.15.0 / pnpm 10.19.0, Kysely 0.28.18, pg-boss 12.38.0. Shared packages compiled dist/declarations; root shared:build учитывает зависимости. В S0-05 зависимости и lockfile не менялись.

## Проверено

- S0-05 PASS: frozen install/typecheck/build; **96 unit + 53 DB/integration** (identity 12, temporal 9, ingestion/queue 17, auth 11, baseline 4), **10 Node fixtures**, migration verifier/docs links/git diff. Новый importer regression сначала воспроизвёл отсутствие ledger resolution, исправлен и пройден.
- Compiled Node reader в рабочей БД: 10 stored accounts, verified identity=0, proofs=0, aliases=0, identity revision=0. Synthetic test data только в отдельных temporary DB, затем cleanup. Нового live evidence не создавалось.
- Исторический live evidence: S0-01 recent 20-map audit; S0-02 карта 9069021061 дважды через очередь, одна карта/10 slots/revision 1, canonical IDs 0/10. S0-04/05 не делали provider requests и не закрывают S0-08/09.
- S0-03 ранее: 2 Chromium E2E + mobile/desktop visual; S0-00 ранее: 6 Python tests / 12 parity. UI/E2E/Python в S0-05 не менялись и не повторялись. Production model не создавался; demo synthetic_only/deployable:false.

## Запуск и ограничения

- Frozen install → `pnpm db:migrate` → `pnpm owner:create` в локальном терминале → `pnpm dev`. Web строго по WEB_ORIGIN (обычно http://localhost:5173).
- Новый API/worker требует 010. `pnpm test:identity`, `test:temporal`, `test:auth`, `test:ingestion`, `test:e2e` требуют PG16/CREATEDB. PG доступен; API/Vite не оставлены работающими; кластер .tools/pgdata не пересоздавать.
- HTTPS production требует AUTH_COOKIE_SECRET >=32 random characters. Dev loopback без него использует process-local CSRF signing key; reload/me обновляет CSRF.
- Windows sandbox блокирует некоторые child processes; проверки выполнялись с разрешённым запуском вне песочницы. Docker/Compose отсутствуют: containers/TLS/restore/remote CI не проверены. Push/deploy не выполнялись.
- Account evidence append — внутренний доверенный boundary, не автоматическая проверка provider payload. Legacy mutable current links не становятся as-of evidence. Conflicts не разрешаются last-write-wins; отдельный manual review/supersession UI остаётся S5-03.
- Нет аналитических страниц/API, полного patch/draft/hero eligibility resolver, frozen DatasetBuilder/production training/activation. Retrospective participation ≠ pre-known lineup; identity/lineup resolution ≠ prediction eligibility. Derived caches должны включать identityRevision и map dataRevision.

## Следующая задача

**S0-06 [P0] Матчевый контекст и валидность героев.** Читать POINT_IN_TIME_AND_MATCH_CONTEXT, PATCH_AWARE_ANALYTICS, DRAFT_DATA_INTEGRITY; расширять существующий evidence boundary для проверенного patch/draft context и hero eligibility. Не выводить first pick из Radiant, не применять текущие draft rules к старым картам; отсутствие правила → null. Не внедрять S0-07/S3 feature builder заранее. Рекомендуемая модель: **GPT-6 Astra · High**.
