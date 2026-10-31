# Журнал разработки

## 2026-10-27 — стартовый комплект (documentation + skeleton)

- Подготовлены AGENTS.md, полное ТЗ, требования к аналитике и ML, документация по источникам и API.
- Добавлены pnpm workspace, health-only Fastify, техническая Vue-страница, SQL начальной схемы, мигратор, Docker PostgreSQL, чистые аналитические функции и unit-тесты.
- **Не реализованы:** auth, импортер, реальные страницы команд, Draft Lab, ML inference/training, частная история аккаунта.
- **Проверено:** структура JSON и YAML, синтаксис SQL на уровне структуры таблиц (19), `node --check` для мигратора, smoke-тесты чистых аналитических функций через Node.js. **Не проверено:** установка npm-зависимостей, выполнение миграции в работающем PostgreSQL, сборка полного проекта — среда подготовки не имеет доступного pnpm/сети и Docker.
- Следующая задача для Codex: **S0-00** из `docs/IMPLEMENTATION_PLAN.md`.

## Шаблон следующей записи

### YYYY-MM-DD — TASK-ID
- Changes:
- Files:
- Tests actually run (pass/fail/blocked):
- Risks:
- Next task:

### 2026-10-27 — Уточнение ТЗ: roster-aware и замены

Сформулированы требования к истории игроков независимо от организации, pairwise co-play, exact-five, churn, baseline vs actual и stand-ins без фиксированного штрафа. Добавлены `docs/ROSTER_CONTINUITY.md`, миграция 003 и чистые описательные TS-утилиты с тестами. Модели, API и визуальный сценарий ещё не реализованы. Не отмечать задачи плана выполненными.

### 2026-10-27 — Reprioritized MVP backlog v3 (documentation only)

- Обновлены задачи `S0-00..S5-05` с явными `[P0/P1/P2]`, перечнем зависимостей и gate.
- Добавлены нормативные контракты на point-in-time, identity/provenance, evaluation/what-if и forward-only миграция `004_context_identity_provenance.sql`.
- Проверка структуры документов и согласованности имён файлов — при упаковке. **PostgreSQL migration и end-to-end тесты не выполнялись** в этой среде (нет PostgreSQL/Docker).
- Реализованных фич и закрытых тикетов это обновление не добавляет. **Следующая задача Codex: S0-00**.

### 2026-10-27 — v4: Continuous Learning / model feedback (architecture, not implementation)

- Добавлены нормативный контракт `docs/CONTINUOUS_LEARNING_PIPELINE.md`, миграция `005_training_pipeline.sql` (frozen datasets/maps, training/eval runs, model promotions) и P0/P1 задачи.
- Зафиксировано: verified pro map — label; пользовательские и модельные прогнозы не обучающие метки и не множат игры. Manual offline training/quality gate P0; scheduled retraining + opt-in auto-promotion P1.
- Ранее созданные SQL миграции 001–004 не изменялись. Реальные DB integration/training/HTTP jobs **не реализованы и не проверены**.
- Следующая задача Codex: **S0-00**; после bootstrap по зависимостям выполнить **S0-07** до обучения/первой публикации модели.

### 2026-10-27 — v5: engineering architecture and library decisions (documentation only)

- Подготовлены `docs/TECHNICAL_ARCHITECTURE_AND_STACK.md`, `DEPENDENCY_MATRIX.md`, `ENGINEERING_PATTERNS.md`, `DATA_PIPELINE_DESIGN.md`, `ML_ENGINEERING_DECISIONS.md`, `DEPLOYMENT_AND_TESTING.md`, `TECH_DECISION_REGISTER.md`.
- Обновлены `AGENTS.md`, общий implementation plan, архитектура/README/ADR; критические выборы привязаны к существующим S0–S5 без фиктивного закрытия задач.
- Ключевые решения: modular monolith + PostgreSQL `pg-boss`, SQL-first миграции + Kysely, Vue Query, DB opaque session, Python sklearn offline + TS inference golden parity; temporal `lineup known-at` vs lineup from post-map history.
- **Только документация:** не устанавливались новые пакеты, не запускался полноценный CI/DB/ML. Миграции 001–005 сохранены без изменений.
- Следующая задача Codex: **S0-00**, затем S0-01 и остальные по зависимостям.


### 2026-10-27 — v7 engineering completion pass (package build, not project completion)

- Added DX/QA scripts, synthetic fixtures, Python demo train/evaluate, Python-JS golden parity, PostgreSQL/Playwright test definitions, CI, Caddy/production compose, backup/restore and handoff/design-system docs.
- Tests actually run in preparation: Node fixture tests, migration checksum verifier, Python pytest, synthetic training/evaluation and Python-JS parity.
- BLOCKED in preparation: npm registry inaccessible => real pnpm-lock.yaml not generated; Docker/PostgreSQL absent => DB integration, Docker production smoke/restore not run; TS/Vue/Playwright deps unavailable => no pnpm typecheck/unit/build/e2e execution.
- Migration SQL 001–005 unchanged. No auth, real provider collector, production predictions or model promotion implemented.
- Next Codex task: **S0-00 / DX-00** on networked machine with Docker; follow `CODEX_V7_START_PROMPT.md`.

## v8 — Prediction Data Feasibility (documentation)

- Added source/feature/availability matrix, audit CLI and synthetic offline example. API field coverage **not measured live** due unavailable outbound DNS. S0-08 remains unchecked; next: execute live audit, document actual field coverage before implementing a bulk collector.

### 2026-10-28 — v9 draft source quality (architecture and synthetic checks)

- Новая нормативная спецификация разделяет original `picks_bans`, 10 played heroes и validated timeline, фиксирует независимые quality facets и stage-specific dataset gates.
- Подготовлены forward-only миграция 006, расширенный аудитор и шесть синтетических регрессий к обнаруженным формам аномалий; исходные миграции 001–005 не менялись.
- Запущены Node regression tests и синтетический audit schema v2; PostgreSQL/Docker migration и v9 live coverage тест **не выполнялись** в среде подготовки.
- Next: S0-00, затем S0-02 + S0-10 и QA-04; historic patch-stratified source audit до S3.

### 2026-10-30 — S0-00 / bootstrap environment gate DX-00

- Goal / implemented: проверен существующий Git checkout `dotaanalitic` (main, origin Ritle/dotaanalitic, изначально clean); создан настоящий pnpm 10.19.0 lockfile из registry и проверен frozen install. Запущены локальные API/Web и отдельная чистая PostgreSQL 16.15 без Windows-службы. Новые продуктовые функции и S0-01 не реализовывались.
- Fixes: LF для SQL через `.gitattributes` вместо изменения golden/hash; `-0` при нулевом overlap (воспроизведён существующим golden-тестом), strict TS counter access; отдельные Vitest/Playwright runner; `.env` loading для dev/start/db/integration/preflight; Zod configuration errors без значений env; Node >=22.12, strict Vite port, DB preflight независимо от Docker в dev.
- Changed files: `.gitattributes`, `.gitignore`, `pnpm-lock.yaml`, root/API/web package scripts, API app/server + new config/config tests, analytics roster, Vite config, preflight, PostgreSQL tests; README, DEVELOPMENT_PREFLIGHT, IMPLEMENTATION_PLAN, PROJECT_STATE, V7_ACCEPTANCE и новый S0_00_VERIFICATION. Содержимое миграций 001–006 не менялось, SQL diff пустой.
- PASS actually executed: registry lock bootstrap; `pnpm install --frozen-lockfile`; `pnpm typecheck`; `pnpm test` (26); `pnpm build`; migration verifier (6, baseline 001–005 intact); doc links; Node fixtures (10); `pnpm db:migrate` (6 APPLIED), повтор (6 SKIP); `pnpm test:integration` (4); `pnpm preflight:strict --require-db` (7 checks, 0 failures, Docker WARN); `pnpm dev` + `pnpm smoke`; `pnpm test:e2e` (1 Chromium); visual screenshot/no browser page errors; Python pytest (6), synthetic train/evaluate + Python↔JS parity (12).
- Initial failures resolved: Windows checkout CRLF checksum mismatch; analytics TS2532/negative zero; Vitest collecting E2E. Windows sandbox initially denied child processes/temp/browser cache; checks subsequently rerun with allowed execution, no tests disabled. Python tested in isolated 3.11.9 `.venv`; default system 3.14 was not used.
- Architecture / compatibility: pure roster cutoff rules preserved, opaque BIGINT preserved in DB tests, frozen dataset/draft immutability and cross-map references verified, `.env` and local `.tools` ignored. Demo artifact remains `synthetic_only:true`, `deployable:false`; no active model, private endpoint or live data collector added.
- BLOCKED / unexecuted: Docker/Compose unavailable; compose container runtime/production image builds and restore drill not run. PostgreSQL gate executed natively, not via Docker. Remote GitHub Actions not run and no push/deploy performed. Workflow commands reviewed against locally executed checks; future private routes still require auth.
- Evidence / restart commands: [S0_00_VERIFICATION.md](S0_00_VERIFICATION.md). S0-00 and its overlapping DX-00 environment criteria complete for local development; deployment/container gates remain separate.
- Next task: **S0-01 — OpenDota provider spike**, starting from DATA_SOURCES / PREDICTION_DATA_SPEC and source availability evidence; not started in this session.

### 2026-10-30 — S0-01 / OpenDota provider spike

- Goal / implemented: named server-side `OpenDotaClient`, consumed-field Zod schemas, bounded `pnpm provider:spike` CLI, source/version/fetchedAt/SHA metadata and separate internal raw body. No new HTTP route, DB importer, worker, model or dependency added.
- Live evidence actually measured: audit schema v2 `sample=20` received 20/20 detailed maps, failed=0; teams/series 15/20, 10 picks/structural draft consistency 19/20, final heroes/slots/provider patch/nonempty accounts 20/20. Typed client checked 3 explicit maps + discovery/team/roster/player in 7 attempts, no retries. `9066936100` retains 12 raw picks; `9063023867` now has raw `null`, distinct from the owner's earlier 1-event observation. Source correction cause remains unknown.
- Fixtures: five sanitized live-shape projections in `tests/fixtures/opendota/provider-spike`, IDs/times/names/stat values replaced or removed, `synthetic:true`; never production training/statistics. Aggregate public evidence committed under `docs/evidence`; detailed local report/raw payloads/credentials not committed.
- PASS actually executed: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test` (54 total, 28 provider/fixture tests), `pnpm build`; Node fixtures/regressions (10), PostgreSQL integration (4), migration verifier (6, SQL unchanged), doc links, HTTP health smoke, live audit + provider spike. UI/Python/E2E unchanged and not repeated in this task.
- Boundaries reviewed: safe numeric/decimal IDs -> JSON strings, zero sentinel -> null only in typed projection; exact raw action order/extras retained; unknown first pick/draft rules/roles/lineup known-at never inferred. `proClassification` remains unverified; proMatches is source discovery, not blanket league/tier approval. Current team-member flags do not create a five-player lineup.
- Rate/terms decision: personal private use of documented API; optional key in Bearer header, fixed host, redirects denied, <=45/min and 25 attempts/run, bounded retries/timeouts/body size with Retry-After. Actual headers show minute/day remaining; upstream daily default differs from old monthly-doc assumptions. Durable global/day/month quota belongs to S0-02. Public redistribution/art/logos not part of this task.
- Changed files: `apps/api/src/providers/opendota/{schemas,client,spike}.ts`, `apps/api/tests/opendota.test.ts`, five provider fixtures, root/API scripts, `.env.example`, `.gitattributes` (LF for checksum-tracked evidence JSON), README/DATA_SOURCES/PREDICTION_DATA_RESEARCH_STATUS/IMPLEMENTATION_PLAN/PROJECT_STATE/PROGRESS, new `S0_01_PROVIDER_SPIKE.md` and public evidence JSON. No SQL or lockfile changes.
- Blockers / limits: no historical stratified sample, no verified pre-start availability; S0-08/09 remain open. Docker/remote CI unchanged from S0-00 (not executed); no push/deploy. An initial PowerShell unquoted CSV joined IDs with spaces; CLI now rejects invalid IDs before requesting discovery, and documented commands quote CSV.
- Next task: **S0-02 (+ associated S0-10 raw/quality contracts)**. Recommended model: **GPT-6.1 Sol · High**; review data provenance, provider corrections and idempotent transactions carefully before activating ingestion.

### 2026-10-31 — S0-02 + associated S0-10 / idempotent ingestion

- Goal / implemented: import одной карты end-to-end через durable pg-boss worker, PostgreSQL global budgets, immutable provenance/raw draft, independent quality facets и conflict handling. CLI enqueue/once/status; нет нового HTTP endpoint, scheduler, training или model activation.
- Changed files: новые `packages/ingestion` (client/schema/runtime/quota/quality/importer + tests), `packages/db/src` и TS build, `apps/worker` (CLI/queue/Dockerfile/tests), migration `007_idempotent_ingestion.sql`, test DB helper. API provider exports/spike используют shared runtime; live audit теперь использует общий DB budget. Обновлены root/API/DB packages, registry lockfile, CI, production compose/API Dockerfile, env examples/.dockerignore, docs-link scanner, baseline DB test migration list, README/plan/source/dependency/preflight/operations docs, PROJECT_STATE и новый S0_02_INGESTION + aggregate live evidence. Исходные SQL 001–006 не менялись.
- PASS actually executed: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test` (64), `pnpm build`; `pnpm test:ingestion` (16), `pnpm test:integration` (4), Node fixtures/regressions (10), migration verifier (7/historical golden), docs links, health smoke. 007 APPLIED, repeat 7 SKIP. Synthetic integration data создаются/удаляются только в отдельных случайных временных БД.
- Actual live evidence: профессиональная карта `9069021061`, league `20395`, два pg-boss job завершены accepted; повтор `duplicate:true`, `dataRevision:"1"`, одна карта/10 слотов/один source snapshot/один raw observation. Canonical player IDs 0/10, verified draft actions 0, active models 0. Подробнее [S0_02_INGESTION.md](S0_02_INGESTION.md), [evidence](evidence/s0-02-live-import.json). Одна карта не является corpus/ML coverage gate.
- Architecture constraints: positive league-tier policy вместо discovery=>pro; completed observation вместо bool winner alone; null known_at/patch/roles без доказательства; verified canonical links only; source accounts отдельно. Raw 0/11/12 picks сохраняются, 10 matching picks не подтверждают historic draft rules. One map = one observation. Conflict не переписывает известный факт, снимает is_pro; frozen predictions/datasets не затрагиваются. Bigint identity > JS safe integer покрыта PG regression.
- Failures resolved: initial quota timestamp infinity arithmetic; test-helper module resolution; regression outcome without completion; durable deferred-job output link. Node fixture runner сначала заблокирован sandbox `spawn EPERM`, затем разрешённый повтор 10 PASS; проверки не отключались. Retry-After deferral и completion атомарны, send failure rollback проверен.
- Blockers / compatibility: Docker отсутствует, container builds/runtime, remote GitHub Actions и restore drill не выполнялись. UI/Python/E2E не менялись и не повторялись. Auth/product UI/bulk history/identity/context/patch/model gates остаются будущими задачами; accepted import не означает training eligibility. No push/deploy.
- Next task / precise entry point: **S0-03 [P0] Личный доступ**, API Auth + users/sessions SQL, CLI owner provisioning, Argon2id, opaque session/cookie/CSRF/rate limit, 401/403/expiry tests.
- Suggested model / effort: **GPT-6.1 Sol · High**, по routing guide и [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6.1-sol); переключение выполняет владелец.

### 2026-10-31 — S0-03 / single-owner authentication

- Goal / implemented: единственный CLI-provisioned owner, Argon2id, opaque DB session с hash-only token/TTL/rotation/revocation, default private-route guard, exact Origin + session-bound CSRF и per-IP/global login throttling. Минимальный web login/logout/loading/error/router restore; preferences/analytics не входят в срез.
- Changed files: новые `apps/api/src/modules/auth/{service,http,owner-cli}.ts`, auth PG/CLI tests; API app/config/unit tests/package; migration `008_owner_auth.sql` и baseline migration list. Shared contracts schemas + compiled exports/build; web auth/router/views/App/styles/main, PG-backed E2E/config/Vite proxy/Web Dockerfile; root/web scripts, API/web workspace deps, registry pnpm-lock; helper ESM marker, CI PG service/auth suite, compose secret/env examples/preflight; README/API/dependency/preflight/operations docs, PROJECT_STATE/plan и новый S0_03_OWNER_AUTH.
- PASS actually executed: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test` (66), `pnpm build`; `pnpm test:auth` (11, CLI create/reset with UTF-8 Unicode password + sanitized error/log path), `pnpm test:ingestion` (16), `pnpm test:integration` (4), Node fixtures (10), migration verifier (8/historical golden), docs links. 008 APPLIED, repeat 8 SKIP. Strict preflight DB: 7 checks/0 FAIL/Docker WARN; compiled Node app health=200/private me=401.
- Browser PASS: `pnpm test:e2e` (2 Chromium) against real Fastify + isolated PostgreSQL; mobile 360px/keyboard/no overflow, wrong password, login/reload, HttpOnly cookie/no web storage, CSRF logout/back navigation. Mobile/login and desktop/account screenshots inspected visually. Traces disabled to avoid credential/session capture.
- Architecture reviewed: no public signup/reset endpoint, owner index permits one row including inactive account. Password reset serializes with issuance and revokes all sessions. DB global credential budget survives process restart and accepts at most 10 attempts/15min; IP limit 5/min ignores spoofed forwarding headers (trustProxy=false). Production HTTPS + persistent >=32-character signing secret required; local loopback HTTP explicitly uses separate cookie names. Raw body/password/cookie/CSRF/query/internal exception never emitted by default logger/error responses.
- Initial failures resolved: stopped local PostgreSQL restarted without replacing data; strict TS plugin callback/Argon2 literal types; invalid URL Zod refinement preserving sanitized error; health unit explicit synthetic DB config; Playwright ESM helper/root env; history test seeded actual previous application entry (login/logout replace history). No tests disabled; all DB/browser data synthetic only in disposable test databases.
- Compatibility / limits: 001–007 SQL unchanged, frozen ML/predictions untouched, active models not added. Shared contracts now build to dist; root commands and API/web Docker dependency builds adjusted. Native Argon2 prebuild exercised despite pnpm ignored install-script warning; no arbitrary scripts enabled. Production containers/TLS/remote GitHub Actions/restore not executed (Docker absent); Python unchanged/not repeated, no push/deploy.
- Owner setup remains local: `pnpm owner:create` in a real terminal; no owner/password was invented in the working DB. Open WEB_ORIGIN exactly. [Contract/runbook/results](S0_03_OWNER_AUTH.md).
- Next task / precise entry point: **S0-04 [P0] Point-in-time schema / temporal semantics**, POINT_IN_TIME_AND_MATCH_CONTEXT + existing source/field observations; preserve event_at/known_at/fetched_at and stage availability without hindsight.
- Suggested model / effort: **GPT-6 Astra · High** per routing guide and [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6-astra), due to temporal leakage risk; user switches manually.

### 2026-10-31 — S0-04 / point-in-time temporal context

- Goal / implemented: typed context evidence + strict as-of repository/pure resolver. Three independent clocks, explicit availability/stage, nullable map/series/score/side/lineup/role/draft facts; current outcome/telemetry cannot enter context whitelist. Historical completed-lineup backfill never becomes pre-known evidence implicitly.
- Changed files: contracts temporal Zod schemas; db temporal pure functions + MatchContextRepository; new migration 009 extending immutable field observations; 16 pure tests + 9 real PG integration tests; root test:temporal, db workspace dependencies/test script, pnpm-generated lockfile, CI, baseline migration list. README/data model/PIT/preflight/operations docs, S0_04_TEMPORAL_CONTEXT, PROJECT_STATE and plan updated.
- PASS actually executed: pnpm install --frozen-lockfile, pnpm typecheck, pnpm test (82), pnpm build; pnpm test:temporal (9), pnpm test:integration (4), pnpm test:ingestion (16), pnpm test:auth (11), Node fixtures (10), migration verifier (9/historical golden), doc links and git diff check. 009 APPLIED, repeat 9 SKIP. Compiled Node repository read against existing imported map: zero invented as-of facts. No live provider requests.
- Regression found and fixed before applying 009 to working DB: sub-millisecond SQL known_at could be rounded into millisecond cutoff on JSON projection. First test failed as expected; typed evidence now rejects sub-millisecond timestamps in SQL as well as contracts, full suite passed. Existing raw observations unaffected.
- Architecture: append idempotency covers concurrent retries/canonical JSON/native slot order; insert + data_revision increment atomic. Every new proof immutable, original provenance retained; contradictory as-of evidence returns CONFLICT, late-known corrections do not change earlier fields. Series score retained but unavailable to MVP features; A/B requires explicit radiantSlot and first pick remains independent. User-asserted/retrospective cohorts not silently promoted; role estimates retain basis/confidence. Historical completion helper is only a temporal predicate, not pro/outcome/identity gate.
- Compatibility / limits: 001–008 unchanged, next SQL 010+. No API/UI feature, identity verification workflow, patch-rule resolver, dataset builder, actual historical coverage or probabilities added. E2E/Python unchanged and not rerun this task; Docker/remote CI/production TLS/restore still unexecuted. Sandbox pnpm install hung/recreated modules; stopped and restored with approved pnpm install, frozen install passed. Child-process EPERM tests passed on approved rerun; no tests disabled.
- Next task / precise entry point: **S0-05 [P0] Identity & lineup integrity** — docs/IDENTITY_AND_DATA_QUALITY.md + ROSTER_CONTINUITY.md, verified external links/aliases, canonical career across transfers, role/lineup evidence; reuse strict context boundary, do not infer identity from nickname or current-team flag.
- Suggested model / effort: **GPT-6 Astra · High**, project routing recommendation for identity/roster correctness; supported effort checked in [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6-astra). User switches manually.

### 2026-10-31 — S0-05 / canonical identity and lineup integrity

- Goal / implemented: immutable account proof ledger + alias provenance, pure verified Steam32 resolver, historical identity/participation reader across organizations, strict lineup/role resolver using S0-04 evidence. No nickname/current-members merging, no fixed stand-in penalty, no new public endpoint or prediction.
- Changed files: contracts identity schemas; db identity/resolver/repository + pure/PG tests; migration 010 with evidence/alias immutability and registry revision triggers; ingestion shared resolver, identity_resolution provenance/context fingerprint, normalizer opendota-map-v2-identity, integration regression. Root test:identity, CI, baseline migration list; README/identity/roster/data-model/preflight/operations docs, S0_05_IDENTITY_LINEUP, progress/state/plan.
- PASS actually executed: pnpm install --frozen-lockfile, pnpm typecheck, pnpm test (96), pnpm build; pnpm test:identity (12), pnpm test:temporal (9), pnpm test:ingestion (17), pnpm test:integration (4), pnpm test:auth (11), pnpm test:fixtures (10). Migration verifier (10/historical golden), docs links, git diff checks. 010 APPLIED; repeat 10 SKIP. No dependency/lockfile changes.
- Regression evidence: new-ledger importer test first FAILED (canonical player null), then passed after shared identity resolution; full ingestion/queue suite passed. Verified multi-account career, equal aliases/different players, provider conflict, immutable/concurrent idempotent proofs, known_at cutoff and future correction, transfers/side swaps, exact-five/pair continuity, full reshuffle, missing native slot, duplicate canonical person, low-confidence roles and missing-vs-zero history all exercised.
- Architecture: one Steam32 namespace for explicitly normalized provider labels; STRATZ network integration remains OFF. Only verified evidence resolves identity, rejection of verified proof/contradicting people fail closed. Legacy links can support current descriptive import but never receive invented historical known_at. Historical reader resolves source accounts as-of instead of trusting stale match_players.player_id; repeatable-read, no organization filter, one map count regardless of aliases/proofs. Retrospective participation is NOT a pre-known lineup/feature cohort. Roles: only confirmed with confidence null/1; estimates or contradictory assignments remain rolePos:null with source estimate retained.
- Actual DB smoke: compiled Node identity reader inspected 10 stored real-map accounts, verified identities=0, proofs=0, aliases=0, identity revision=0. Synthetic identities/maps/owners stayed in temporary test DBs; no live provider requests or fabricated real evidence.
- Compatibility / limits: 001–009 untouched; next SQL 011+. New worker requires 010; old current external links preserved, no automatic player merge/rewrite or bulk reimport. Registry revision must accompany map data_revision in derived caches. No review/supersession UI, official historical coverage, feature builder, trained model or probabilities. E2E/Python unchanged/not rerun; Docker/remote Actions/TLS/restore still unexecuted. No push/deploy.
- Next task / precise entry point: **S0-06 [P0] Матчевый контекст и валидность героев** — POINT_IN_TIME_AND_MATCH_CONTEXT, PATCH_AWARE_ANALYTICS, DRAFT_DATA_INTEGRITY; verified patch/draft rules and hero eligibility, unknown rule remains null, preserve side/first-pick separation.
- Suggested model / effort: **GPT-6 Astra · High** per project routing; model/effort capability checked in [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6-astra), selection remains manual.

### 2026-10-31 — S0-06 / game context and historical hero eligibility

- Goal / implemented: immutable patch release/draft rules/hero availability evidence; pure resolveGameContext and repeatable-read GameContextRepository. Explicit coverage horizon, independent Radiant/Dire vs A/B vs first pick, verified series/map context, exact patch/mode/lobby ruleset and tournament/time hero eligibility. Missing/conflicting evidence remains null; pre-match cannot expose post-draft facts.
- Changed files: contracts game-context + league/mode/lobby facts; db resolver/repository, migration 011, 18 pure tests + 6 PG tests and synthetic helper; root test:game-context, CI, baseline migration list. README/PIT/patch/draft/data model/preflight/operations docs, S0_06_GAME_CONTEXT, plan and state.
- PASS actually executed: pnpm install --frozen-lockfile, pnpm typecheck, pnpm test (114), pnpm build; direct Vitest with env file and --no-file-parallelism across game-context (6), identity (12), temporal (9), importer/queue (17), auth/CLI (11): 55 passed; Node baseline PostgreSQL tests (4), Node fixtures (10). Migration verifier 11/golden historical, docs links and git diff check. 011 APPLIED, repeat 11 SKIP. No dependency/lockfile changes.
- Regression / reruns: new assertion first reproduced missing older proof ID on conflicting release dates; fixed and full unit suite passed. Combined parallel DB run hit cleanup hook and auth CLI timeouts; same six suites passed sequentially without timeout/test changes. Node fixture sandbox run failed spawn EPERM; approved rerun passed. CI already runs separate DB commands; local multi-suite guidance records --no-file-parallelism.
- Architecture: source/event/known/fetched/review/hash immutable; retries idempotent and registry revision atomic. Legacy hero rows unverified; mutable catalogs and completed-map projections never become as-of evidence. Contradictory rules fail closed, no last-write-wins. Ruleset version is separate from actual timeline validation; draftOrderValid remains null until P1 S2-05. Raw 0/11/12 picks/final heroes untouched. Series best_of default never becomes evidence, no between-map probabilities.
- Actual working-DB compiled smoke: existing map resolved with registry revision 0, zero patch/draft/hero proofs and zero available context fields; patch/side/hero eligibility/draft validity null. No real metadata seeded, live provider requests, model or probabilities. Source coverage remains S0-08/09. Synthetic rules only in disposable test DBs.
- Compatibility / limits: SQL 001–010 unchanged; reader requires 011, next migration 012+. Cache keys include registry/map revisions, context/game policy versions and input A/B/cutoff/stage. No public writer/review UI, full timeline validator, analytics UI or DatasetBuilder. UI/E2E/Python unchanged/not rerun; Docker/remote CI/TLS/restore still unexecuted. No push/deploy.
- Next task / precise entry point: **S0-07 [P0] Архитектура verified outcomes и frozen datasets** — CONTINUOUS_LEARNING_PIPELINE + migration 005; enforce verified pro/winner/orientation and frozen dataset invariants, exclude predictions/guesses from labels. Actual DatasetBuilder remains S3-00.
- Suggested model / effort: **GPT-6 Astra · High**, project recommendation for SQL/frozen-label/temporal correctness; supported effort previously checked in [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6-astra). User switches manually.
