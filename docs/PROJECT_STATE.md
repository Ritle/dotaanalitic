# Текущее состояние репозитория — Codex handoff

**Обновлено:** 2026-10-31. S0-00/DX-00, S0-01, S0-02 + S0-10, S0-03, S0-04, S0-05 и **S0-06** выполнены локально. **Функциональный MVP ещё не готов.** Рабочий Git checkout — dotaanalitic; родительский starter не редактировать.

## Реально присутствует

- Vue login/logout/router guard; Fastify health/auth, CLI owner provisioning/reset, Argon2id, opaque sessions/CSRF/rate limits. Owner в рабочей БД автоматически не создавался. [S0-03](S0_03_OWNER_AUTH.md).
- Import одной карты через pg-boss: quotas/retries, idempotency, immutable receipts/raw/quality. Raw 0/11/12 picks сохраняются; historical known_at/roles/patch не угадываются. [S0-02](S0_02_INGESTION.md).
- S0-04: MatchContextRepository + pure strict-asof-v2 (league/mode/lobby добавлены в S0-06), independent event/known/fetched, typed context observations, stage/cutoff/conflict gates. [Контракт](S0_04_TEMPORAL_CONTEXT.md).
- S0-05: immutable identity/alias evidence, IdentityRepository, verified Steam32 resolver; importer opendota-map-v2-identity сохраняет proof IDs/status. Ники не объединяют людей. historyForPlayers пересчитывает identity по source accounts на cutoff, pro/completed only, через организации. Retrospective participation не означает pre-known lineup. Lineup/role reader использует S0-04 proof, estimated/low-confidence роли остаются null. [Контракт](S0_05_IDENTITY_LINEUP.md).
- **S0-06:** GameRegistryRepository + pure resolveGameContext + repeatable-read GameContextRepository. Immutable release/draft/hero evidence, покрытие патчей, независимые side/first-pick, hero allow/deny/unknown. draftOrderValid остаётся null до P1 S2-05. [Контракт](S0_06_GAME_CONTEXT.md).
- PostgreSQL 16.15 native localhost/SCRAM; **001–011 применены**, повтор 11 SKIP. SQL 001–010 в этой задаче не менялись; golden 001–005 совпадают. Следующая миграция **012+**.
- Node 22.15.0 / pnpm 10.19.0, Kysely 0.28.18, pg-boss 12.38.0; shared packages compiled dist/declarations. В S0-06 зависимости и lockfile не менялись.

## Проверено

- S0-06 PASS: frozen install/typecheck/build; **114 unit + 59 DB/integration** (game context 6, identity 12, temporal 9, ingestion/queue 17, auth 11, baseline 4), **10 Node fixtures**, migration verifier/docs links/git diff.
- Regression полного списка proof IDs при конфликте дат патча сначала воспроизведён, затем исправлен. Parallel DB run получил cleanup/CLI timeouts; все 55 Vitest DB tests прошли последовательно с --no-file-parallelism, без изменения таймаутов. Baseline 4 отдельно. Node fixture EPERM устранён разрешённым повтором вне sandbox.
- Compiled GameContextRepository smoke на рабочей карте: registry revision=0, patch/draft/hero proofs=0, available context fields=0; patch/side/heroes/draft validity остаются null. Synthetic rules только в temporary test DB.
- Исторический live evidence: S0-01 recent 20-map audit; S0-02 карта 9069021061 дважды через очередь, одна карта/10 slots/revision 1, canonical IDs 0/10. S0-05 smoke: 10 accounts, verified identities/proofs/aliases=0. S0-04/05/06 не делали provider requests и не закрывают S0-08/09.
- S0-03 ранее: 2 Chromium E2E + mobile/desktop visual; S0-00 ранее: 6 Python tests / 12 parity. UI/E2E/Python в S0-06 не менялись и не повторялись. Production model не создавался; demo synthetic_only/deployable:false.

## Запуск и ограничения

- Frozen install → pnpm db:migrate → pnpm owner:create в локальном терминале → pnpm dev. Web строго по WEB_ORIGIN (обычно http://localhost:5173).
- Новый game-context reader требует 011. test:game-context, test:identity, test:temporal, test:auth, test:ingestion, test:e2e требуют PG16/CREATEDB. PG доступен; API/Vite не оставлены работающими; кластер .tools/pgdata не пересоздавать.
- HTTPS production требует AUTH_COOKIE_SECRET >=32 random characters. Dev loopback без него использует process-local CSRF signing key; reload/me обновляет CSRF.
- Windows sandbox блокирует некоторые child processes; проверки выполнялись с разрешённым запуском вне песочницы. Docker/Compose отсутствуют: containers/TLS/restore/remote CI не проверены. Push/deploy не выполнялись.
- Registry/account evidence append — внутренний доверенный boundary, не автоматическая верификация provider payload. Legacy mutable links/rules не становятся as-of evidence. Conflicts не разрешаются last-write-wins; manual review/supersession UI остаётся S5-03.
- Нет аналитических страниц/API, полного draft timeline validator, frozen DatasetBuilder/production training/activation. Реальные patch/draft/hero rules не seed-ились. Resolution контекста не означает prediction eligibility. Derived caches включают identityRevision, game registryRevision, map dataRevision, policy versions и effective inputs.

## Следующая задача

**S0-07 [P0] Архитектура verified outcomes и frozen datasets.** Читать CONTINUOUS_LEARNING_PIPELINE, DATA_QUALITY_GATES и migration 005; добавить SQL/contract gates для pro/winner/team orientation, immutable frozen datasets и единственного map ID per dataset/stage. Прогнозы/guesses не становятся labels. DatasetBuilder остаётся S3-00; не менять SQL 001–011. Рекомендуемая модель: **GPT-6 Astra · High**.
