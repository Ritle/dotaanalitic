# Модель данных и правила SQL

Главная исполняемая схема новой БД: `packages/db/migrations/001_initial.sql` (PostgreSQL 16). **Не выполнять одновременно** с legacy схемой из старого ZIP. Файл `001_initial.sql` рассчитан на чистую БД и не является миграцией уже работающего v1 проекта.

## Предметные сущности

- `teams`, `players`, `heroes`, `patches`, `leagues` — справочники. Внешние OpenDota IDs отличать от внутренних PK.
- `team_roster_periods` — наблюдения о членстве во времени; `verified=false` для флага API current-member.
- `series` — турнирная серия, `matches` — отдельные сыгранные карты.
- `matches` — истинность `is_pro`, команды Radiant/Dire, результат, патч, качество, sync state.
- `match_players` — один слот 0..4 / 128..132; `player_id` nullable, `hero_id` обязателен только при полноценной строке участия.
- `match_draft_actions` — исторические picks/bans при доступности.
- `scenarios` — редактируемый личный сценарий с `revision`, `cutoff_at`, A/B командами, `radiant_slot`.
- `scenario_lineup` — 5 ролей на каждой стороне, nullable player/hero при частичном сценарии.
- `scenario_draft_actions` — текущее пользовательское состояние последовательности picks/bans.
- `analysis_runs` и `prediction_runs` — история immutable вычислений и exact inputs.
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
