# Модель данных и правила SQL

## S2-07 — контекст известных ranked-карт (SQL046)

ranked_context_receipts: immutable UUID receipt, parent_observation_id→ranked_practice_observations, canonical player/account, identity_revision, policy_version, actual fetched_at, payload (knownAt=null/map event times/raw SHA), raw_body и recorded_at. Update/delete запрещены прежним immutable trigger; source observations не переписываются. ranked_context_map_cache: account+match+policy PK, receipt FK, expires_at; найденные согласованные факты24h, negative/conflict1h. ranked_context_leases: account PK, lease token/until120s, retry_at/failure_code, shared STRATZ budget отдельно. Parent/identity/membership/lease проверяются атомарно при записи; кэш повторно сверяется с текущим parent при чтении. Контекст не входит в matches/pro/training tables и не увеличивает N/WR. [API и ограничения](S2_07_STRATZ_ENRICHMENT.md).

## S2-07 — отдельные ranked-public observations

Миграция045 добавляет `ranked_practice_observations`: append-only canonical player/verified account/provider, identity revision, fetchedAt, normalized typed payload и private raw bodies с SHA в receipts. UPDATE/DELETE запрещены. `ranked_practice_cache` содержит provider/account key, observation FK, TTL/lease/cooldown; публикация атомарна и повторно проверяет identity под блокировкой registry state. Ни pro-таблицы, ни training/prediction snapshots не используются для этих наблюдений. [Период, допуск карт и API](S2_07_RANKED_PRACTICE_READER.md).

## S2-01 — текущие связи ожидаемых заявок

SQL040 добавляет append-only `provider_player_links` — общие решения owner/PandaScore-player→canonical-player/Steam32 с binding FK и server recorded_at — и hashed `search:<sha256>` keys существующего cache. Исправления добавляют новые решения; прежние snapshots и identity proofs не меняются. Legacy связи читаются консервативно из последних командных пятёрок, противоречия показываются явно. Alias заявки сохраняется только после owner-confirm с текущими availability clocks. [Схема](S2_01_UNIFIED_PLAYER_CATALOGUE.md).

SQL039 добавляет cache key `player:<Steam32>` к существующему cache. Таблицы/сохранённые snapshots не переписываются; SQL001–038 неизменны. Profile proof хранится независимо от registry proof: append-only player_account_evidence + binding.source.profiles. Ни отсутствие в `/proPlayers`, ни публичный профиль сами по себе не определяют pro-статус карты или участие в будущей встрече.

Дополнение SQL037–038: отдельный cache `directory` для bounded `/teams` и `provider_team_catalogue(provider,external_team_id,team_id,source,recorded_at)`. Numeric PandaScore→canonical organization mapping уникален и неизменяем. Новая организация может иметь `opendota_team_id IS NULL`; это не мешает созданию проверенных числовых аккаунтов. История и team ID других источников не присваиваются по названию, существующие frozen snapshots не переписываются.

Миграция **036_expected_roster_catalogue.sql** добавляет `roster_catalogue_cache` (проверенные raw/source observations с TTL/lease/cooldown), append-only `expected_roster_catalogue_bindings` (owner, provider team, canonical team, revision, request и snapshot выбранных пяти) и `roster_catalogue_operations` (межпроцессный lease подготовки). Существующие SQL001–035 не меняются. Numeric account evidence/aliases создаёт существующий IdentityProvisioner; текущий `knownAt` не доказывает historical roster availability. Связь PandaScore→account — явный выбор владельца для сценария, не новая verified historical attendance. [Подробности](S2_01_EXPECTED_ROSTER_CATALOGUE.md).

**S3-07 scheduled lifecycle (2026-11-03):** SQL034 добавляет `v1_scheduled_lifecycle` (owner/providerMatchId/revision), immutable event/request/SHA chain и проверки переходов/времени/сохранённого target. Отмена сериализуется с journal capture и scheduled issuance. Guard SQL033 расширен проверкой cancellation, запрет после played-map binding сохранён. Новые journal v3 inputs/reports фиксируют точный inventory последних событий и сохранённых bindings; v1/v2 replay прежний. SQL001–033 не изменены. [Правила и границы](S3_07_V1_SCHEDULED_TARGET_LIFECYCLE.md).

**S3-07 scheduled binding owner flow (2026-11-03):** новых таблиц/SQL нет. Owner facade использует прежние v1_schedule_result_bindings и v1_forecast_outcome_revisions/refresh_requests. Lookup связывает owner+target+forecast до idempotency recovery; map ID для refresh берётся из immutable binding. GET не переверифицирует и не дописывает записи, history имеет exclusive revision cursor20. Original forecast/model/input/report и SQL001–033 сохраняются. [Контракт](S3_07_V1_SCHEDULED_BINDING_OWNER_FLOW.md).

**S3-07 scheduled owner flow (2026-11-03):** новых SQL/таблиц нет. Owner HTTP adapter использует существующие immutable runtime snapshots и schedule_target_request_id, чтение/history фильтруются по owner+target revision. Реальная попытка не преобразуется в what-if, input/output/clock/model/provider IDs не принимаются из HTTP body. Ручной новый сценарий сохраняется обычным ScenarioRepository после подтверждения5v5. Все SQL001–033 и прежние модели/отчёты сохраняются. [Контракт](S3_07_V1_SCHEDULED_OWNER_FLOW.md).

**Дополнение текущего среза:** SQL033 и runtime owner lock запрещают новую выдачу после сохранённой связи с completed map во всех редакциях встречи. Устаревшее future/not_started расписание не открывает её заново; ранее выданные записи и exact retry сохраняются. SQL032 после применения не переписывалась.

**S3-07 scheduled result (2026-11-03):** SQL032 добавляет append-only v1_schedule_result_bindings: owner/request hash, pinned target revision FK, prediction/map/series IDs, exact record/SHA, reviewedAt отдельно от recorded_at. Per-owner advisory lock сериализует retries/уникальность; одна карта не назначается разным встречам, редакции одной встречи не меняют связанную карту. SQL пересчитывает verified outcome при INSERT. Прежний verifier027 сохранён, общий resolved helper имеет те же правила; wrapper031 расширен проверкой отдельной связи. SQL journal guard учитывает provider namespace. Старые SQL001–031/snapshots/reports неизменны. [Контракт](S3_07_V1_SCHEDULED_RESULT.md).

**S3-07 scheduled runtime (2026-11-03):** SQL031 добавляет nullable `v1_runtime_snapshots.schedule_target_request_id` и composite owner/request FK к `v1_schedule_targets`. `targetReview.scheduleBinding` содержит versioned immutable target record/SHA и актуальное нормализованное наблюдение источника с clocks. SQL проверяет owner/latest revision/ref/source/scenario/pre-start; общий model/release guard сохранён. Прежний OpenDota outcome verifier перенесён под внутреннее имя, wrapper отвергает PandaScore до реализации verified binding. Старые snapshots/reports и SQL001–030 не меняются. [Контракт](S3_07_V1_SCHEDULED_RUNTIME.md).

**S3-07/V1 target lifecycle (2026-11-03):** SQL029 добавляет immutable `v1_target_lifecycle`: owner + OpenDota series/map1 + revision, request hash, event bytes/SHA, parent SHA и recorded time. Manual owner cancellation/reopening — отдельный audit, не outcome/label. V2 journal замораживает полный latest lifecycle inventory; SQL028 validation расширена только новой миграцией, v1 read/replay сохранены. Проверенная связь с сыгранной картой всегда приоритетнее отмены. [Правила и команды](S3_07_V1_TARGET_LIFECYCLE.md). SQL001–028 неизменны.

**S3-07/V1 owner API/UI (2026-11-03):** новых таблиц/миграций нет; `V1JournalService` читает существующий immutable отчёт028 и строит bounded HTTP projection (50 попыток, summary без raw input). История использует owner/revision cursor по20 записей. Ожидаемые5v5, статус первоначального расчёта и источник исхода берутся из frozen report input. Пагинация не меняет primary/метрики; чтение сверяет pure replay по сохранённым данным и не дописывает outcome/report revisions. HTTP startup fingerprint проверяется до нового INSERT, старые GET/retry сохраняются. [Контракт](S3_07_V1_JOURNAL_OWNER_API_UI.md).

**S3-07/V1 journal metrics (2026-11-03):** forward-only028 добавляет `v1_journal_reports`: owner/requestId, линейная revision/previous SHA цепочка, capture time, frozen input/report bytes и SHA. Полный inventory до5000, каждый документ до32MiB; SQL source/verification guards, immutable UPDATE/DELETE/TRUNCATE. Input хранит проекцию всех V1 snapshots владельца, ссылки на outcome bindings и новые read-only проверки исходов. Primary выбирается глобально до model/time/status filters, matched-lineup slice отдельно после выбора; cancelled пока null с предупреждением. [Контракт](S3_07_V1_JOURNAL_METRICS.md). SQL001–027 сохранены.

**S3-07/V1 real targets (2026-11-02):** forward-only027 расширяет runtime-validator для заранее сохранённого `real_map` и explicit OpenDota series/map1, сохраняя прежние model/release/immutability проверки. `verify_v1_forecast_outcome` повторно использует verified pro-outcome boundary, проверяет map/series/teams/league/proof и precise pre-start eligibility. Новые `v1_forecast_outcome_revisions` (linear previous SHA, exact result bytes) и `v1_forecast_refresh_requests` (owner/request idempotency) immutable. Это версия связи V1 отдельно от legacy `prediction_outcomes`; старые snapshots и SQL001–026 сохранены. [Контракт](S3_07_V1_REAL_TARGET.md).

**S3-06/V1 runtime (2026-11-02):** forward-only026 добавляет `v1_runtime_snapshots` (exact JSON bytes/SHA, owner/requestId/hash, FK prediction), `prediction_runs.v1_request_id/issued_at`; вероятность хранится NUMERIC без округления до4 знаков. Сценарий/revision/model/activation/latest-report binding проверяются SQL, UPDATE/DELETE/TRUNCATE снимков запрещены. Unavailable попытки имеют null probability/issuedAt. Текущий purpose только `what_if_single_map`, не prospective forecast; verified outcomes и primary selection остаются S3-07. [Контракт](S3_06_V1_RUNTIME_SNAPSHOTS.md). SQL001–025 сохранены.

**S3-05/V1 registry (2026-11-02):** forward-only025 добавляет `v1_model_artifacts` с exact plan/kernel/freeze bytes и SHA, привязкой к существующей `prediction_model_versions`; registration inactive, без fictitious fitting run. Общий `model_activation_events` получает V1 journal FK, requestId/hash и sequence; SQL атомарно переключает active flags, проверяет latest report/CAS, сохраняет audit и запрет прямой активации без события. Прежний fitted-model branch и dataset FK в `model_evaluation_runs` сохранены. SQL001–024 не менялись. [Контракт](S3_05_V1_MODEL_REGISTRY.md).

**S3-03/V1 executable freeze (2026-11-02):** capture может содержать полный manifest, новый report `v1-release-evaluation-v2` — его fingerprint/SHA и проверяемый quality gate. Repository сверяет freeze/capture/report/scorer при записи и чтении. Старые capture/report v1 читаются без изменения bytes и остаются releaseGate false. Внешний `journalled-v1-release-report-v1` и таблица024 совместимы; SQL001–024 не менялись, новая миграция не нужна. [Контракт](S3_03_V1_EXECUTABLE_FREEZE.md). Это не пользовательский forecast journal S3-07.

**Release evaluation journal (024, 2026-11-02):** `v1_release_evaluation_journal` отдельно от `research_evaluation_journal` (023) и пользовательских forecast/outcome snapshots. PK `(plan_fingerprint, revision)`, immutable capture/report bytes + SHA, candidate/binding в отчёте, scorer-code SHA, parent report SHA/reason и DB recorded_at. Plan-scoped advisory lock, unique input/code pair, parent FK/linear append и UPDATE/DELETE/TRUNCATE guards. Возврат метрик только после commit; повтор возвращает сохранённые bytes. [Контракт и команды](S3_03_V1_RELEASE_EVALUATION.md). Это журнал проверки качества, не выполнение обязательного S3-07 forecast journal.

Главная исполняемая схема новой БД: `packages/db/migrations/001_initial.sql` (PostgreSQL 16). **Не выполнять одновременно** с legacy схемой из старого ZIP. Файл `001_initial.sql` рассчитан на чистую БД и не является миграцией уже работающего v1 проекта.

## Предметные сущности

- `research_evaluation_journal` (023, S3-01/E1) — immutable first committed evaluation и линейные revisions по plan fingerprint; точные capture/report bytes+SHA, scorer manifest SHA, parent revision/report SHA, причина и DB recorded_at. Transaction lock/unique/FK/immutable triggers, retry без пересчёта; отдельная сущность от будущего журнала пользовательских прогнозов. [Контракт E1](S3_01_E1_PROTOCOL.md).
- `teams`, `players`, `heroes`, `patches`, `leagues` — справочники. Внешние OpenDota IDs отличать от внутренних PK.
- `team_roster_periods` — наблюдения о членстве во времени; `verified=false` для флага API current-member.
- `series` — турнирная серия, `matches` — отдельные сыгранные карты.
- `matches` — истинность `is_pro`, команды Radiant/Dire, результат, патч, качество, sync state.
- `match_players` — один слот 0..4 / 128..132; `player_id` nullable, `hero_id` обязателен только при полноценной строке участия.
- `match_draft_actions` — исторические picks/bans при доступности.
- `scenarios` — редактируемый личный сценарий с `revision`, `cutoff_at`, A/B командами, `radiant_slot`.
- `scenario_input_snapshots` (015, S2-01) — append-only `(scenario_id,revision)`, validated manual input JSONB/hash и server recorded_at; текущие проекции меняются атомарно с новой редакцией. [Контракт](S2_01_SCENARIOS.md).
- `scenario_lineup` — 5 ролей на каждой стороне, nullable player/hero при частичном сценарии.
- `scenario_draft_actions` — текущее пользовательское состояние последовательности picks/bans.
- S2-02/016: unordered `scenario_bans` отдельно от timeline; assignments в scenario_lineup.hero_id, scenarios.league_id optional, immutable snapshots.draft_assessment nullable без backfill старых входов. [Контракт](S2_02_DRAFT_LAB.md).
- `analysis_runs` и `prediction_runs` — история immutable вычислений и exact inputs.
- S2-04/017: versioned analysis_runs имеют scenario_revision FK, per-scenario report_version/counter, terminal full result и SHA-256. DB запрещает UPDATE/DELETE, проверяет frozen input; legacy unversioned jobs сохраняют свой lifecycle. [Контракт](S2_04_SCENARIO_REPORTS.md).
- `prediction_model_versions` — модель и проверенные offline метрики.
- `sync_jobs` — долговременные состояния фоновых задач.
- `app_users`, `auth_sessions` — единственный владелец, без регистрации.

## Строгие SQL-предикаты

Для любой pro-метрики: `m.is_pro IS TRUE AND m.started_at < :cutoff_at AND m.radiant_win IS NOT NULL`. Для выборки на патче используйте `m.patch_id = :patchId`, исключайте NULL patch от patch-scoped расчёта, указывайте его в coverage. Для игрока/героя должны существовать корректные `match_players` на нужной стороне. `detail_status=complete` проверять только для показателей, которым реально нужно десять слотов; team WR допускает подтверждённый матч без полного roster.

Не конвертировать BIGINT ID через JS `Number` — HTTP сериализация в decimal string. Нельзя выводить статистику pro-патча из `/heroStats` или `/players/:id/heroes`.

## Известные ограничения baseline schema

- Точный текущий состав и роли не считаются автоматически подтверждёнными на основании OpenDota API.
- `scenario_lineup` — 10 слотов (PK A/B + role_pos), уникальность игрока/героя проверяется и в БД, и в сервисе.
- `match_draft_actions` не гарантируется источником для каждой исторической карты; не делать status=complete без проверки.
- Для реальной серии определение `series_id` может быть неизвестно; при ML-разбиении группировать по надёжной группе series или временной эвристике с предупреждением; запретить leakage.
- `prediction_runs` immutable на уровне сервиса, не являются database-enforced append-only; в production позже можно добавить trigger.

## Уточнения перед подключением реального импортера

1. Реальный OpenDota `match_id` / `team_id` / `account_id` — внешние IDs: проверить маппинг и отсутствие silent conflicts.
2. `picks_bans[].team` — номер стороны по контракту провайдера; не угадывать, проверить на реальном fixture.
3. Строго проверить 10 уникальных `player_slot` / `hero_id` и radiant_win до маркировки complete.
4. Привязку патча к `started_at` выполнять по release times в источнике patch metadata, сохраняя source revision.
5. Проверить реальный формат `leagueid`, nullable data, ошибки 404, RateLimit на небольшом sample.

## Расширение для актуальности патчей (migration 002)

`002_patch_awareness.sql` добавляет `patches.patch_type`, `release_source_url`, `source_revision`, `metadata_updated_at` и таблицу `patch_hero_impacts` для подтверждённых изменений отдельных героев. При проверке источника неизвестную дату/версию нельзя заменять предполагаемой. Для фильтра `patch_id` используются только точные соответствия; патчевые корректировки и `n_eff` для ML хранятся как versioned JSON snapshots (без денормализации в `matches`). См. `docs/PATCH_AWARE_ANALYTICS.md`.

Отложенных абсолютных коэффициентов при импорте не сохранять: веса зависят от `cutoff_at`, версии модели и параметров, поэтому их вычисляет детерминированный feature builder. При исправлении даты релиза patch metadata нужно переопределить ошибочно сопоставленные матчи, инвалидировать кэш и создать новую ревизию агрегатов, сохраняя историю предсказаний неизменной.

## Миграции

Файлы миграций `\d+_*.sql` выполняются по алфавиту через `scripts/migrate.mjs` и фиксируются `schema_migrations(filename, checksum, applied_at)`. **После применения не редактировать SQL**: изменения базы через `002_*.sql` и далее. Для существующего v1 используйте специализированный путь миграции из прежней документации, но он не является частью свежего старта.

## Roster-aware extension (migration 003)

`003_roster_continuity.sql` создаёт `scenario_expected_lineup` как **необязательную** базовую пятёрку (team slot, role, player ID, источник, владелец подтверждения). Реальное выбранное состояние остаётся в `scenario_lineup`. Членство `team_roster_periods` — наблюдение, а не состав конкретной карты. Историческая сторона карты восстанавливается из `match_players` как пять **уникальных идентифицированных** аккаунтов одной стороны; нельзя восстанавливать её по API current-member.

`roster fingerprint` — отсортированные пять player IDs без team ID; для pair co-play fingerprint — два player IDs, также без team ID. Team-context churn считается отдельно. Метрики читаются через `match_id` и `side`, не через декартовы соединения множества players. Миграции 001/002 не менять, если уже применены. Подробности: `docs/ROSTER_CONTINUITY.md`.

## Migration 004 — контекст, учёт личности, lineage, исходы прогнозов

`004_context_identity_provenance.sql` **добавляет**, не заменяя старые миграции:

- `series` / `matches`: проверенный `map_number`, pre-map score, `first_pick_side`, `draft_order_version`, venue / stage. NULL остаётся неизвестным. Не заполнять эти поля фиктивным контекстом при импорте.
- `scenarios`: желаемый / известный first-pick slot, map number и предматчевый счёт, stadium/online, `parent_scenario_id` для P1 what-if.
- `match_field_observations` и `match_source_snapshots`: происхождение, версия адаптера, evidence, fetched vs known time и конфликты.
- `player_alias_history`, `player_external_accounts`, `player_role_observations`, `team_roster_periods.known_at`: каноническая личность, verified account link и факт роли с доказательством времени.
- `hero_availability_rules`: подтверждённая доступность героя для патча/лиги с интервалом и источником.
- `prediction_outcomes`: прикреплённый после матча **реальный** исход, без изменения immutable `prediction_runs`.

`match_field_observations.value` — необработанное JSONB наблюдение; selected canonical value в `matches` может устанавливаться только при решённом конфликте. `known_at` не заменяется `fetched_at`. Для response quality нельзя считать `n_raw` количеством источников: это число отдельных карт. В последующих задачах не добавлять публичную регистрацию, billing или распределённые очереди. Подробности: `docs/POINT_IN_TIME_AND_MATCH_CONTEXT.md` и `docs/IDENTITY_AND_DATA_QUALITY.md`.


## Инвариант v3: неизменяемость прогнозов

После перехода `prediction_runs.status` в `done`, `failed` или `unavailable` миграция `004_context_identity_provenance.sql` блокирует UPDATE записи триггером. Повторный расчёт обязан создать новый `prediction_runs.id`; привязка фактического результата хранится отдельно в `prediction_outcomes`. Это не заменяет прикладной контроль авторизации, snapshot metadata и фиксацию ревизии сценария.

**V1 journal scope2026-11-02:** [TECHNICAL_SPEC §0.9](../TECHNICAL_SPEC.md) требует basic forecast/outcome journal до первого выпуска. Текущая схема не доказывает наличие готовых issued_at/primary-selection/association revision contracts: при реализации проверить поля и добавить023+ при необходимости, сохраняя001–022. `created_at` задачи не заменяет время успешной выдачи; current `is_active` не заменяет evidence активации на момент выдачи. One-primary-per-actual-map и versioned outcomes/aggregate reports не изменяют исходный prediction snapshot; несколько runs не увеличивают training N. Это дизайн следующего обязательного среза, не выполненная миграция.

## Архитектурные сущности непрерывного обучения (migration 005)

- `training_dataset_versions` — frozen manifest, `stage`, source/data/patch/code revisions, feature/label/cutoff policies, train/calibration/validation/test split policy, SHA-256 fingerprint.
- `training_dataset_maps` — один `match_id` на один dataset version; Team A/B orientation, `cutoff_at`, immutable as-of features/hash и **проверенная** послематчевая метка `team_a_won`. INSERT/UPDATE валидирует `matches.is_pro`, фактическую сторону и результат; после freeze изменение/удаление запрещено DB-триггером.
- `model_training_runs` — offline run/config/seed/dataset/status (не обозначает опубликованную модель).
- `model_evaluation_runs` — независимая temporal test/eval + baseline/champion, quality gates/metrics с неизменяемым итогом.
- `prediction_model_versions.training_run_id`, `artifact_sha256` — происхождение опубликованного артефакта; `is_active` означает прошедшую регистрацию, а не готовность без внешнего gate.
- `model_activation_events` — append-only audit переключения / отката, atomic stage-scoped activation.
- `prediction_outcomes` (004) — verified связь прогноз↔факт для оценки качества, **НЕ training_dataset_maps**.

Все P0 таблицы вводятся **forward-only** файлом `005_training_pipeline.sql`, предыдущие 001–004 не переписывать. Пункты P1 — автоматизация retraining и Model Performance — не реализуются в SQL. Подробности: `docs/CONTINUOUS_LEARNING_PIPELINE.md`.

Исправить устаревшее ограничение baseline schema выше: начиная с миграции 004 `prediction_runs` имеет DB-триггер для запрета UPDATE терминального снимка; до применения 004 это обеспечивалось только сервисом.

## v9 — новое хранение draft source / quality (migration 006)

- `match_draft_source_observations`: неизменяемые original `picks_bans` массивы или `NULL`, source/adapter/hash/fetched_at, FK на карту и необязательный снапшот.
- `match_quality_assessments`: versioned multi-dimensional quality records (outcome, player, heroes, organizations, series, timeline), anomaly JSONB, метрики; `draft_order_valid` nullable и не равен структурному количеству событий.
- `match_players.hero_id` остаётся финальным сыгранным героем; `match_draft_actions` — только строгая нормализация validated timeline. Нельзя тихо исправлять 12 picks ради десяти.
- Уровень доступности для обучения модели вычисляется по stage/as-of/feature revision, **не** хранится как глобальный `training_eligible` флаг.

See [DRAFT_DATA_INTEGRITY.md](DRAFT_DATA_INTEGRITY.md); 001–005 remain immutable.

## S0-04: типизированные temporal observations

Миграция 009 расширяет immutable `match_field_observations` event/availability/stage/fingerprint. `context.*` — отдельные проверяемые typed facts; старые raw observations не получают историческую известность автоматически. `MatchContextRepository` сохраняет доказательства идемпотентно и читает только доступные на cutoff/stage поля; карта/серия, side/A-B и роль/slot остаются разными понятиями. [Подробный контракт](S0_04_TEMPORAL_CONTEXT.md). `started_at` означает фактический старт карты, а не known_at.

## S0-05: account evidence и состав

S3-07 дополнение SQL030: [v1_schedule_targets](S3_07_V1_SCHEDULE_TARGET_REGISTRATION.md) — immutable owner-scoped назначение карты1 по PandaScore meeting ID, без fabricated canonical map/series. PK owner/provider_match/revision, unique owner/request UUID, request hash, source-observation FK, record bytes/SHA и server recorded_at. Запись содержит explicit ручное сопоставление команд/nullable турнира, source clocks и parent SHA. Trigger проверяет latest observed source, future status/time, canonical IDs и pending/null; UPDATE/DELETE/TRUNCATE запрещены. Сохраняет организационное назначение, не составы/прогноз/результат. SQL001–029 не менялись.

Миграция 010 добавляет immutable `player_account_evidence`, alias provenance и `identity_registry_state.revision`. Общий resolver различает current identity и verified-asof; importer сохраняет proof IDs/status, retrospective history пересчитывает identity по source accounts на cutoff без фильтра организации. Canonical `match_players.player_id` не является достаточным as-of gate. `lineupAsOf` использует S0-04 context evidence, отдельно проверяет роли и не читает current-members flags. [Контракт](S0_05_IDENTITY_LINEUP.md).

## S0-06: game-context registry

Миграция 011 добавляет immutable `patch_release_evidence`, `draft_rule_evidence`, evidence provenance для `hero_availability_rules`, `game_context_registry_state.revision` и расширяет context whitelist полями league/mode/lobby. Legacy rules не становятся verified. GameContextRepository разрешает patch/side/hero eligibility на cutoff в repeatable-read; policy/revisions/proof IDs входят в результат. Исторические SQL 001–010 не менялись. [Контракт](S0_06_GAME_CONTEXT.md).

## S0-07: verified dataset boundary

Миграция 012 добавляет outcome_receipt_id (composite FK к той же карте), match_data_revision и series_id_snapshot в training_dataset_maps. SQL сверяет pro/outcome/orientation с immutable receipt и league reference; building → frozen повторно проверяет источник, хронологию и целую серию. Frozen/rejected защищены от изменения/удаления; header/stage нельзя менять при существующих примерах. PostgreSQL формирует canonical content и SHA-256; Bigint IDs в content — строки, timestamps — UTC. Старые frozen snapshots не переписываются. Это durable architecture, а не feature eligibility или готовый DatasetBuilder. [Контракт](S0_07_VERIFIED_DATASETS.md).

## S0-09: readiness и серверное время записи

Миграция 013 добавляет nullable recorded_at в match_field_observations. BEFORE INSERT trigger устанавливает верхнюю миллисекундную границу clock_timestamp независимо от входного значения; immutable guard запрещает изменение. Legacy строки остаются NULL. Это независимая отметка сервера, не event_at/known_at/fetched_at источника. Owner assertions допускаются только при recorded_at и fetched_at не позже cutoff; публичный датированный архив может быть получен позднее.

DataReadinessRepository читает observations, map bounds и release registry в repeatable-read; отдельные strict/owner/conditional policies требуют явного профиля. Завершённые match_players не служат неявным источником состава. Ready означает только запрошенную доступность контекста, eligibility для обучения и прогноза не оценивается. Снимки не записываются этим reader; будущий DatasetBuilder обязан заморозить выбранную cohort/policy/assumptions. SQL 001–012 не изменены. [Контракт](S0_09_DATA_READINESS.md).
## S2-01: current role hints, migration035

`role_profile_bindings` — append-only owner/team revisions, explicit STRATZ team/Panda team/player role-only mapping, UUID replay и optimistic revision. Не canonical identity proofs. `role_profile_cache` — mutable bounded provider projection с source clocks/hash, TTL/lease/cooldown; `role_profile_stratz_quota` — shared UTC-day counter/spacing. Не training targets и не historical roles. Существующие migrations001–034, lineups, role observations и V1 model inputs не меняются. [Контракт и проверки](S2_01_ROLE_PROFILES.md).

## SQL041 — selected player history

player_history_runs stores owner, canonical/Steam32 binding snapshot, lineup SHA, durable job state, attempt fencing, bounded report and source audit. Independent from organization ID; immutable prior migrations and frozen model data remain unchanged. [Contract](S2_01_PLAYER_HISTORY.md).

SQL042 adds validated player_history_runs.options with90/10 defaults for existing rows. Existing report v1 bytes and legacy lineup keys retain their meaning; new keys incorporate non-default options. Reports v2 record page count and bounded-search coverage. [Contract](S2_01_PLAYER_HISTORY.md).


### SQL044 — schedule freshness admission

`schedule_source_freshness_reason_v1` закрепляет operational policy `schedule-source-age-v1`: non-future source clock и возраст строго меньше 5 минут. Новые independent AFTER INSERT triggers на `v1_schedule_targets` и `v1_runtime_snapshots` сверяют связанное immutable наблюдение с `clock_timestamp()` после existing validators/locks. Stale/future source вызывает исключение и rollback всей новой операции. Схемы/bytes прежних записей, exact retries, SQL001–043, prediction/release guards и frozen executable не переписываются. [Контракт](S4_V1_SCHEDULE_FRESHNESS.md).

### SQL043 — evidence-only player history continuation

player_history_runs adds operation (import default/evidence_resume), parent_run_id and scope_map_ids. Resume children refer to an owned terminal original import with identical bindings/options/lineup key; accepted/duplicate scope is checked by SQL. Original parent report is frozen after child creation; terminal resume reports immutable except operational next_allowed_at. player_history_projection_replays stores run/attempt/map -> original receipt, hero/league references -> derived receipt/SHA/time; update/delete/truncate rejected. Derived bytes never masquerade under the original payload SHA. Old SQL001–042 and old event/known/fetched clocks remain unchanged. [Details](S2_01_HISTORY_ENRICHMENT_RESUME.md).
