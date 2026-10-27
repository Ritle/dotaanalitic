# AGENTS.md — Dota 2 Pro Analytics

> This file is the primary operating contract for Codex in this repository. Read this file first, then the documentation listed below. This product is a personal **single-owner** Dota 2 **professional-match** analytics application, NOT a commercial/multi-user SaaS.

## 1. Source of truth and priority

In case of conflicts, follow (highest first):
1. Direct task description from the user for the current Codex session.
2. `AGENTS.md` (scope, engineering and quality gates).
3. `TECHNICAL_SPEC.md` (approved Personal MVP requirements and v4 continuous-learning architecture).
4. `docs/TECHNICAL_ARCHITECTURE_AND_STACK.md`, `docs/ENGINEERING_PATTERNS.md`, `docs/DATA_PIPELINE_DESIGN.md`, `docs/ML_ENGINEERING_DECISIONS.md`, `docs/DEPLOYMENT_AND_TESTING.md`, `docs/DEPENDENCY_MATRIX.md`, `docs/TECH_DECISION_REGISTER.md`, `docs/ARCHITECTURE.md`, `docs/POINT_IN_TIME_AND_MATCH_CONTEXT.md`, `docs/IDENTITY_AND_DATA_QUALITY.md`, `docs/MODEL_EVALUATION_AND_SCENARIOS.md`, `docs/CONTINUOUS_LEARNING_PIPELINE.md`, `docs/SCREEN_SPECS.md`, `docs/DATA_MODEL.md`, `docs/PREDICTION_ENGINE.md`, `docs/API_CONTRACTS.md`.
5. `docs/CODEX_MODEL_ROUTING.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PRIORITY_TRACEABILITY.md`, `docs/ACCEPTANCE_CRITERIA.md`, `docs/DATA_SOURCES.md`.
6. Existing code and tests, provided they do not contradict items 1–5.

If a requested implementation conflicts with the specification, explain the conflict in your final delivery and propose a limited solution. Avoid speculative features.

## 2. Mission / MVP scope

Build a localhost-first personal dashboard with one manually provisioned owner account. Support team/player professional-match statistics, historic match comparison, manually edited 5v5 lineups, hero picks/bans, player-on-hero performance, ally hero pairs and enemy hero matchup matrix. Support **two independently validated map-win probability models**: pre-match (before draft) and post-draft (10 distinct heroes). Store reproducible, immutable prediction snapshots.

Excluded from MVP: public sign-up, subscriptions, team workspaces, multiple users, commercial payments, live telemetry, series BO3/BO5 probability, betting features, mass Dotabuff HTML scraping, automated claims of prediction accuracy, ML models without backtesting.

## 3. Technology and repository layout

- Monorepo: **pnpm workspaces** / Node.js 22+ / strict TypeScript.
- UI: Vue 3 + Vite + Vue Router + Pinia (adopt incrementally) in `apps/web`.
- API: Fastify 5 + Zod contracts in `apps/api` and `packages/contracts`.
- Persistent data: PostgreSQL 16; forward-only migrations `packages/db/migrations/001_initial.sql` → `002_patch_awareness.sql` → `003_roster_continuity.sql` → `004_context_identity_provenance.sql` → `005_training_pipeline.sql` → `006_draft_data_quality.sql`. Database IDs are bigints; serialize IDs as **strings** in JSON to avoid JS precision loss.
- Pure descriptive analytics: `packages/analytics`. Prediction feature builders/TS inference live in `packages/prediction`; offline Python scikit-learn fitting/calibration lives in `ml/` when implemented, with tested artifact/inference parity. Pure point-in-time `MatchContextResolver` and `IdentityResolver` boundaries must be testable without network; no separate microservices.
- Primary source: OpenDota server-side HTTP client. STRATZ is optional and **OFF** by default.
- Queued work: PostgreSQL-backed `pg-boss` planned from S0-02; at-least-once, idempotent jobs, no Redis/microservices. Kysely for typed repositories while `.sql` forward-only migrations remain the schema authority.
- Docker Compose provides PostgreSQL for local work. Web and API run locally during development.

## 4. Non-negotiable correctness rules

1. **Pro-only data:** use ONLY matches with positively established `matches.is_pro IS TRUE` for professional statistics; never substitute total `/players/:id/heroes` or all public matches.
2. **Point-in-time:** all historical features require `historical_match.started_at < cutoff_at`, strictly. Never leak outcomes, duration, GPM, kills or other post-start features of the predicted match.
3. **One observation = one Dota map.** Do not confuse a BO3 series with one map. All maps from the same known series must be in one model validation fold.
4. **One player per map side; one hero per map slot.** Radiant is `player_slot 0..4`, Dire `128..132`; don't infer side from array index.
5. `n=0` -> `null` rate, not zero. Unknown fields remain `null`; do not invent heroes, roles, scores, match history or predictions.
6. Ally synergy counts **one map once per unordered pair on the same side**; counter matchup counts a map once for a **directed** hero A vs B pair.
7. Team A/B in UI are **not** Radiant/Dire unless specifically assigned. A valid post-draft prediction needs 10 **distinct** heroes.
8. Win probabilities may appear **ONLY** when models pass a documented, reproducible temporal backtest, evaluation/calibration gate and coverage checks. Otherwise respond `status: 'unavailable'`, `teamAWinProbability: null`, reasons. Do not fabricate 50/50.
9. Store the source, sync time, sample size, effective filters, status, model/version and input snapshot with each report or prediction.
10. Ensure imports are idempotent; protect rate limits, respect Retry-After, handle 429/5xx, missing accounts and partial drafts.
11. Do not automatically assign five roles based on a team's recent-members flag. Manual lineups are authoritative for a hypothetical scenario.
12. Protect all private endpoints; no hardcoded credentials/secrets. Owner provisioned only via CLI, never public signup.

13. **Patch-aware correctness:** read `docs/PATCH_AWARE_ANALYTICS.md`, `docs/ROSTER_CONTINUITY.md` before implementing importer, hero analytics or prediction. Determine `patch_id` from verified release timestamps, not nearest label; unknown patch stays NULL with coverage warning. Filtered per-patch raw metrics and recency/patch-weighted predictive features MUST be separate and clearly labeled.
14. Historic matches receive feature-specific time/patch/hero-impact weights; older maps should be strongly discounted for post-draft hero synergies but can inform long-term player/team strength with other decay. Never use a single universal weight for all metrics. No fixed decay heuristic is asserted accurate without chronological validation.
15. Track `n_raw`, Kish `n_eff`, patch distribution, policy/model revision and patch cold-start/metadata coverage; invalidate derived caches when patch registry changes. If predictions fail patch-drift / quality gates, return `unavailable`, never fabricate a confidence percentage.
16. **Roster-aware:** read `docs/ROSTER_CONTINUITY.md` before team analysis, importer, scenarios or prediction. `team_id` is an organization, NOT a stable five-player roster. Historical actual lineups come only from five identified `match_players` on the same map side, never `/teams/:id/players` flag.
17. A player's pro-history follows their canonical identity through team transfers; pairwise co-play across **different organizations** counts, with `started_at < cutoff_at`. Calculate exact-five and same-side unordered pair counts separately from all-organization WR.
18. A replacement/stand-in does NOT imply any fixed penalty. `scenario_expected_lineup` is optional and distinct from `scenario_lineup`; compare historical cohesion, personal quality and roles independently. Without expected baseline, no invented roster-change delta. Validate roster features by temporal backtest and missing-ID coverage.

## Model selection hints (v6 — advisory only)

Before a new `Sx-yy` task, read `docs/CODEX_MODEL_ROUTING.md` and, when materially useful, issue ONE concise model + reasoning-effort recommendation **before complex code changes**. Focus especially on point-in-time data, roster identity, patch logic, migrations, ML data leakage and model evaluation. For routine UI and tests, avoid upsell; suggest downgrading to Sol after a critical gate closes. If risk increases during a task, issue at most one extra recommendation with evidence. **You cannot switch the Codex model or infer the user's current selection**; the owner changes it manually. Recommendations are non-blocking and never substitute for testing, security or factual correctness. No repetitive reminders.

## 5. Execution workflow for each Codex task

1. Read `docs/IMPLEMENTATION_PLAN.md` and select the **current unchecked task only** by dependency order; task ID `Sx-yy` is stage, `[P0/P1/P2]` is severity. Do not implement future phases opportunistically.
2. Inspect relevant existing code, DB migration and contracts; articulate a short implementation plan.
3. Implement the **smallest end-to-end vertical slice** that meets the task. Maintain backwards compatibility and migration safety.
4. Add/update tests (pure-function units, API integration, fixtures, DB where applicable); verify known edge cases.
5. Run all checks that are currently available: `pnpm install --frozen-lockfile` (after lockfile generation), `pnpm typecheck`, `pnpm test`, `pnpm build`; do not claim checks passed if unavailable. First installation may need `pnpm install` because starter archive intentionally contains no generated lockfile.
6. Update docs and `docs/PROGRESS.md`: what changed, tests run, unresolved issues and **exact next task**. Never silently mark an unimplemented item done.
7. Deliver a short result: files changed, design decisions, test results, next action. Do not push or deploy unless asked.

## 6. Coding conventions

- TypeScript `strict`, no unnecessary `any`, use Zod validation for external and internal payload boundaries.
- UTC ISO-8601 timestamps; integer / BIGINT-safe IDs exposed as decimal strings over HTTP.
- Organize by business feature and keep SQL/data access out of Vue components. API controllers thin; business logic in services; pure analytics deterministic and testable.
- `pnpm` not npm/yarn. Conventional Commit style for proposed commit messages (`feat:`, `fix:`, `test:`, `docs:`).
- No hidden mocks in production endpoints. Fixtures are only for tests/demo and must be labeled synthetic.
- User-visible errors in Russian; logs and internal code identifiers in English. Accessible layouts (keyboard usage, contrast, loading/error/empty states).
- Avoid overengineering: no Kubernetes, event-bus, distributed microservices, complex role management, AI text generators, or forecasting neural networks in initial phases.
- Never delete or replace existing migration history to change a deployed schema; add a forward-only migration instead. The shipped `001_initial.sql` is for **new** databases.

## 7. Data-provider boundaries

- Source documentation `docs/DATA_SOURCES.md`. Calls from backend only. Use a named client with timeouts, retries, quota budget, validation and observable error codes.
- Treat provider content as untrusted. Validate and normalize before persistence.
- Confirm terms/permissions before commercial or public redistribution, hero art, team logos; do not bypass robots/rate limits or website restrictions.
- Synthetic test fixtures are OK. Never describe synthetic fixtures as live official match statistics.

## 8. Prediction and reporting requirements

- Deterministic `feature_builder` reused for offline training and runtime inference; recorded `feature_schema_version`.
- Baseline Elo first, pre-match regularized logistic regression next, post-draft logistic regression only after sufficient full-draft data.
- Historical data reconstruction/rolling features use only earlier matches, with temporal train / calibration / test and series-group boundaries. Report Brier, log loss, test count, calibration metrics and comparable baseline.
- Produce report probabilities only for models with `is_active=true` and a passed quality gate. Analytics and report pages must still work without trained models.
- Do not treat predictive explanations as causal conclusions. No claim of guaranteed results.

## 9. Definition of done for an implementation task

- Functionality matches the appropriate FR IDs.
- Automated tests cover happy and edge cases (zero sample, duplicate records, missing fields, swapped sides, timestamp cutoff).
- Errors produce useful structured responses; no credentials in responses/logs.
- The UI shows update timestamp, N of sample, filters and quality warnings wherever stats are shown.
- Docs and progress log updated; startup reproducible from README.

## 10. First task

Start with **S0-00 Repository verification and database bootstrap** in `docs/IMPLEMENTATION_PLAN.md`; then progress through numbered tickets sequentially. If user explicitly chooses another ticket, follow their choice.

## 11. Дополнительные обязательные P0 инварианты (MVP v3)

19. **Temporal provenance:** `started_at/event_at`, `known_at`, `fetched_at` are DISTINCT. Backfilling in 2026 does not make data available for a 2023 pre-match prediction. Historic features must satisfy stage-specific availability + cutoff, not just event time. See `docs/POINT_IN_TIME_AND_MATCH_CONTEXT.md`.
20. **Canonical identities:** nickname equality is not identity. Only verified external account links can merge past player histories. Preserve aliases; provider conflicts must be logged, not silently overridden. See `docs/IDENTITY_AND_DATA_QUALITY.md`.
21. **Map/series/side/draft:** winner of one map != winner of BO3; BO2 can end tied. Record verified map_number + pre-map series score when known. Team A/B != Radiant/Dire != first-pick; first pick must not be inferred from Radiant and historical draft rules require historical patch context.
22. **Opponent strength:** compare performance against the opponents' strength AS OF each match. Elo/Glicko is chronological; do not grant a new five the old organization's rating unaltered.
23. **Role-aware features:** hero experience depends on assigned role; do not assume a historical inferred role is certain. Role swaps and stand-ins are separate from team tag and preserved in input snapshots.
24. **Small samples:** show observed n and nullable raw win rate, separate smoothed estimate/prior from raw observed data, effective n for weighted data, no arbitrary certainty score disguised as win probability.
25. **Hero eligibility:** do not assume a hero was selectable at a particular patch/event; use evidence-backed availability rules and show unknown if not verified.
26. **Single-map predictions only for MVP;** optional game context in schema does not authorize series or live between-map prediction. Full draft order, venue/tier/stage and what-if UI are P1; strategic draft archetypes and series forecasts P2.
27. **Immutable evaluation:** predictions freeze features/source/revision/model. Link a final outcome separately after the map, do not rewrite the original prediction. Use same-holdout baseline/pre/post comparison, temporal/series-aware splits and patch/roster ablations.
28. **Priority discipline:** all new `[P0]` gates in `docs/IMPLEMENTATION_PLAN.md` must be satisfied before declaring prediction MVP ready. `[P1]`/`[P2]` must not delay the initial single-owner MVP, though the nullable schema contracts may be added now.

## 12. Continuous learning / verified outcomes (v4; P0 schema, P1 automation)

29. Read `docs/CONTINUOUS_LEARNING_PIPELINE.md` before import, retrospective feature generation, training, registry, model activation or prediction-outcome linking. **An actual verified professional map is the only training target**, never a model probability, manually selected favourite, unverified user outcome or speculative What-if scenario.
30. One canonical `match_id` = at most one example **per dataset version and stage**. Multiple `prediction_runs` linked to one map increase forecast-audit observations, **NOT** training sample count. Training is built from `matches` / verified map results, not by turning saved predictions into labels.
31. Historical input features are computed strictly as-of the map start; labels become available only after the match. Keep labels separate from features, train/calibration/validation/test split by *whole series*, and preserve frozen `training_dataset_versions`, `training_dataset_maps` and provenance. A provider correction results in a NEW dataset revision.
32. Every model artifact has verifiable SHA-256 and traceable training-run/dataset/code/config/seed; a new trained candidate is **inactive** until independent temporal testing and quality gate. Activation and rollback must be atomic, stage-safe, auditable; failing challenger does not displace champion.
33. **P0:** verified-map eligibility, immutable dataset snapshots, manual offline training/evaluation and explicit model activation contracts. **P1:** background/scheduled retraining, ongoing prospective performance and optional approved automatic promotion, **disabled by default**. Never train on every new HTTP request or every imported map; retain model rollback path and `unavailable` fallback.
34. Outcomes from `prediction_outcomes` are for evaluation/monitoring; they do not alter frozen `prediction_runs`. Only prospective, verified, actually pre-start forecasts count toward live performance. Private user guesses, if implemented later, remain outside the shared ground-truth training dataset by default.

## Дополнительные gate v5 — tech design and libraries

- Нормативные инженерные решения: `docs/TECHNICAL_ARCHITECTURE_AND_STACK.md` + документы по patterns, pipeline, ML, operation и `docs/DEPENDENCY_MATRIX.md`. Не путать **planned** библиотеки и уже установленные.
- **P0** SQL-first миграции 001–005 **не менять**. Kysely — только чтение/typed SQL; `pg-boss` own schema отдельно. PostgreSQL remains sole queue/storage for personal MVP; at-least-once jobs + SQL idempotency mandatory.
- **P0** У каждого факта отделять `event_at`, `known_at`, `fetched_at`. Исторически восстановленная по завершённой карте пятёрка **не означает**, что ростер был доступен до драфта: хранить доказательство исторической доступности и разные evaluation cohorts.
- **P0** Offline Python `scikit-learn` training + JSON artifact + TS inference выбран для линейного baseline; обязательны manifest SHA, pinned feature order/preprocess/calibrator, golden Python ↔ TS parity, eligibility/quality gate. Не создавать prediction microservice.
- **P0** Session auth в cookie + server-side opaque session, `argon2id`, CSRF, rate limit. Vue Query отвечает за server cache, Pinia — только за локальное состояние редактирования и auth UI.
- **P1/P2** CatBoost, ML dashboards, richer UX только по заявленным этапам/результатам профилирования; никакой установки библиотек «на всякий случай».


## v7 — обязательный DX/QA gate до функциональных задач

- Перед S0-00 читать `docs/PROJECT_STATE.md` + `docs/DEVELOPMENT_PREFLIGHT.md`; после каждой задачи — `docs/CODEX_WORKFLOW.md` и обновить PROGRESS/PROJECT_STATE. Не читать всю 80k-строчную спецификацию для каждой мелкой задачи.
- Исторические SQL 001–005 обязаны совпадать с `tests/golden/migrations-v6.sha256.json`. Нельзя переписывать их ради прохождения тестов; создать 006+.
- `pnpm-lock.yaml` генерируется **только** pnpm из registry, затем коммитится. Если сети нет — blocker, а не ручная имитация. CI/production требуют `--frozen-lockfile`.
- Синтетика (`tests/fixtures`, `tests/golden/synthetic-logistic-candidate.json`) никогда не участвует в production training/prediction; даже удачно обученная demo модель `deployable:false`.
- Реальные pro исходы, lineup known-as-of и draft timestamp обязательны для любого published model. Контроль качества — `docs/MODEL_VALIDATION.md`, `docs/DATA_QUALITY_GATES.md`.
- Сначала проверка `docs/V7_ACCEPTANCE.md`, затем настройка. Подготовленный Docker/Playwright/PG тест ≠ реально исполненный тест.
- Для UI использовать `docs/UI_DESIGN_SYSTEM.md`; для VPS — `docs/OPERATIONS_RUNBOOK.md`, для логов — `docs/OBSERVABILITY.md`.

## v8: evidence before prediction

`docs/PREDICTION_DATA_SPEC.md` is a normative source/feature/availability contract. Before S1 importer or S3 model use `scripts/audit-prediction-sources.mjs` on live pro maps and report empirical coverage; a synthetic fixture pass is **not** live coverage. Pre-map historical roster provenance cannot be inferred from completed match lineups. Do not treat 10 in-game snapshot rows as 10 independent matches.

## v9 — P0 draft source integrity, eligibility and raw evidence

- Read `docs/DRAFT_DATA_INTEGRITY.md` before modifying OpenDota adapter, importer, match-player/heroes normalization, draft timeline, hero/pair features, dataset selection, or quality audit.
- Keep **raw `picks_bans`**, **observed final 10 heroes**, **validated draft events** as separate entities. Never silently delete pick 11/12, fill in missing picks or assume `draft_actions.length > 0` means valid draft.
- Implement **orthogonal quality assessments**: outcome / player IDs / final heroes / historical team IDs / series / draft integrity / point-in-time model eligibility. `series_id=0` means unknown; an absent organization does **not** discard valid heroes or players.
- Strict `draft_order_valid` is **unknown** unless game mode, lobby type and **patch-specific drafting rules** were checked; 10 matching picks is only structural consistency. `lane_role` is not verified Pos 1–5.
- Migration 006 (`006_draft_data_quality.sql`) appends raw event observations + versioned assessments; **never modify 001–005**. Assessment status is not a static `training_eligible` flag; dataset inclusion is computed by stage/cutoff/evidence/feature revision.
- Add tests for 0/11/12 picks, side mismatch, missing team/series, and original payload immutability. Synthetic cases are fixtures **not** captured real match responses.
- The owner's 50-map audit is evidence of recent field coverage only; not a historical patch-stratified result and not verification of prospective lineup knowledge.
