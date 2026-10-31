# Текущее состояние репозитория — Codex handoff

**Обновлено:** 2026-10-31. S0-00/DX-00, S0-01, S0-02 + S0-10, S0-03, S0-04, S0-05, S0-06, S0-07, S0-08 и **S0-09** выполнены локально. **Функциональный MVP ещё не готов.** Рабочий Git checkout — dotaanalitic; родительский starter не редактировать.

## Реально присутствует

- Vue login/logout/router guard; Fastify health/auth, CLI owner provisioning/reset, Argon2id, opaque sessions/CSRF/rate limits. Owner в рабочей БД автоматически не создавался. [S0-03](S0_03_OWNER_AUTH.md).
- Import одной карты через pg-boss: quotas/retries, idempotency, immutable receipts/raw/quality. Raw 0/11/12 picks сохраняются; historical known_at/roles/patch не угадываются. [S0-02](S0_02_INGESTION.md).
- S0-04: MatchContextRepository + pure strict-asof-v2 (league/mode/lobby добавлены в S0-06), independent event/known/fetched, typed context observations, stage/cutoff/conflict gates. [Контракт](S0_04_TEMPORAL_CONTEXT.md).
- S0-05: immutable identity/alias evidence, IdentityRepository, verified Steam32 resolver; importer opendota-map-v2-identity сохраняет proof IDs/status. Ники не объединяют людей. historyForPlayers пересчитывает identity по source accounts на cutoff, pro/completed only, через организации. Retrospective participation не означает pre-known lineup. Lineup/role reader использует S0-04 proof, estimated/low-confidence роли остаются null. [Контракт](S0_05_IDENTITY_LINEUP.md).
- **S0-06:** GameRegistryRepository + pure resolveGameContext + repeatable-read GameContextRepository. Immutable release/draft/hero evidence, покрытие патчей, независимые side/first-pick, hero allow/deny/unknown. draftOrderValid остаётся null до P1 S2-05. [Контракт](S0_06_GAME_CONTEXT.md).
- **S0-07:** DatasetRepository + typed manifest/example contracts, SQL source/pro/outcome/orientation gate, immutable frozen/rejected snapshots, whole-series/chronological checks, reproducible SHA-256. Это durable boundary, не DatasetBuilder или доказательство feature eligibility. [Контракт](S0_07_VERIFIED_DATASETS.md).
- **S0-08:** audit schema 3, typed league discovery + safe request counters; live 20 recent + 20 historical карт четырёх TI-лиг, 6 observed source patch IDs, 50 HTTP 200 attempts. Evidence/selection/source/code SHA сохранены; historic known-at и canonical identities unassessed. [Отчёт](S0_08_SOURCE_AUDIT.md).
- **S0-09:** DataReadinessRepository + pure assessContextReadiness: strict/owner/conditional cohorts, required/assumed facts, policyKey и map dedupe. Никакого implicit completed-roster fallback; готовность контекста не означает training/prediction eligibility. Миграция 013 фиксирует серверный recorded_at отдельно от source clocks, legacy NULL не допускается как ранний owner input. [Контракт](S0_09_DATA_READINESS.md).
- PostgreSQL 16.15 native localhost/SCRAM; **001–013 применены**, повтор 13 SKIP. SQL 001–012 в этой задаче не менялись; golden 001–005 совпадают. Следующая миграция **014+**.
- Node 22.15.0 / pnpm 10.19.0, Kysely 0.28.18, pg-boss 12.38.0; shared packages compiled dist/declarations. В S0-09 зависимости и lockfile не менялись.

## Проверено

- S0-09 PASS: frozen install/typecheck/build; **139 unit + 71 DB/integration** (readiness 9, temporal/identity/game/dataset/ingestion/queue 58, baseline 4), **18 Node tests**, verifier 13/golden, docs links/git diff. Auth/E2E/Python неизменны и не повторялись. Новые pure/PG suites проверяют clocks/cohorts, conflicts, completeness, patch assumptions и completion microsecond boundary.
- Regression tests сначала воспроизвели зависимость map dedupe от порядка снимков и допуск позднего owner input с подставленным fetchedAt. Исправлены: snapshots сравниваются независимо от ready, owner gate требует server recordedAt <= cutoff. SQL test проверяет принудительную серверную отметку и её immutable защиту.
- S0-09 working-DB read-only smoke: maps=1, datasets=0, active_models=0, registry revision=0, dataRevision=1, временных test DB=0. Strict и explicit conditional дают incomplete, missing lineup/patch/roles/teams, selected maps=0. Все 21 legacy observations сохранили recorded_at=NULL, новых observations=0. Реальные evidence/модели не создавались, provider requests не выполнялись.
- Ранее S0-07 compiled/DB smoke: datasets=0, examples=0, training_runs=0, active_models=0; функция canonical content присутствует. Рабочая БД не пополнялась синтетическими примерами.
- Ранее S0-06 compiled GameContextRepository smoke на рабочей карте: registry revision=0, patch/draft/hero proofs=0, available context fields=0; patch/side/heroes/draft validity остаются null. Synthetic rules только в temporary test DB.
- Исторический live evidence: S0-01 recent 20-map audit; S0-02 карта 9069021061 дважды через очередь, одна карта/10 slots/revision 1, canonical IDs 0/10. S0-05 smoke: 10 accounts, verified identities/proofs/aliases=0. S0-08: 40 recent/historical maps, исходные hashes/evidence не менялись в S0-09; historic known-at по ним по-прежнему unassessed.
- S0-03 ранее: 2 Chromium E2E + mobile/desktop visual; S0-00 ранее: 6 Python tests / 12 parity. UI/E2E/Python в S0-09 не менялись и не повторялись. Production model не создавался; demo synthetic_only/deployable:false.

## Запуск и ограничения

- Frozen install → pnpm db:migrate → pnpm owner:create в локальном терминале → pnpm dev. Web строго по WEB_ORIGIN (обычно http://localhost:5173).
- Context/readiness readers требуют 013; DatasetRepository требует 012. test:readiness, test:dataset, test:game-context, test:identity, test:temporal, test:auth, test:ingestion, test:e2e требуют PG16/CREATEDB. PG доступен; API/Vite не оставлены работающими; кластер .tools/pgdata не пересоздавать.
- HTTPS production требует AUTH_COOKIE_SECRET >=32 random characters. Dev loopback без него использует process-local CSRF signing key; reload/me обновляет CSRF.
- Windows sandbox блокирует некоторые child processes; проверки выполнялись с разрешённым запуском вне песочницы. Docker/Compose отсутствуют: containers/TLS/restore/remote CI не проверены. Push/deploy не выполнялись.
- Registry/account evidence append — внутренний доверенный boundary, не автоматическая верификация provider payload. Legacy mutable links/rules не становятся as-of evidence. Conflicts не разрешаются last-write-wins; manual review/supersession UI остаётся S5-03.
- Нет аналитических страниц/API, полного draft timeline validator, DatasetBuilder/production training/activation. Реальные patch/draft/hero rules не seed-ились. Resolution контекста не означает prediction eligibility. Derived caches включают identityRevision, game registryRevision, map dataRevision, policy versions и effective inputs.

## Следующая задача

**S1-01 [P0] Справочники и обзоры.** Читать SCREEN_SPECS, API_CONTRACTS, UI_DESIGN_SYSTEM и соответствующие разделы DATA_MODEL/IDENTITY_AND_DATA_QUALITY/ROSTER_CONTINUITY. Реализовать поиск teams/players/heroes и freshness; организация, actual five и личность игрока различаются. Не подменять pro-history public totals или current-members flags. Рекомендуемая модель: **GPT-6.1 Sol · High**.
