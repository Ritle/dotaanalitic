# Архитектура MVP

## Схема

```text
Vue SPA  ─── REST /api/v1 ─── Fastify API ───── PostgreSQL
                               │  │                  ▲
                               │  └─ data services ─┘
                               │
                               ├─ OpenDota adapter (server only)
                               ├─ analytics (point-in-time SQL + pure TS)
                               ├─ durable sync jobs (`pg-boss` worker) / importer
                               └─ prediction (offline train + gated inference)
```

## Границы

- `apps/web`: интерфейс, роутинг, состояния, отображение статистики и предупреждений. В браузере **нет** секретов внешних API и SQL.
- `apps/api`: HTTP и auth, запросы к БД, инициирование sync и report jobs, версионирование отчётов.
- `packages/contracts`: Zod DTO, единые коды ошибок/предупреждений и строковые BIGINT ID.
- `packages/analytics`: **чистые** расчёты pro-only результатов, SQL запросы могут быть выделены в API/db слой.
- `packages/prediction` (создаётся на этапе S3): общий feature builder для offline/online, TS JSON-artifact inference, quality gate. Python training/evaluation CLI живёт отдельно в `ml/` без ML web-service.
- `packages/db`: forward-only `.sql` миграции (единственный DDL source of truth), `pg`/Kysely типизированные репозитории и транзакции.

## Основные потоки

1. Создание матча: UI выбирает две команды → API читает локальную БД → если недостаточно, создаёт sync job и возвращает статус «загрузка» → пользователь подтверждает lineups → сохраняется сценарий.
2. Статистика: UI запрашивает отчёт → API формирует корректную выборку `is_pro IS TRUE`, `started_at < cutoff_at`, патч/период → считает показатели и покрытие → сохраняет versioned `analysis_runs`.
3. Синхронизация: job → rate limiter → OpenDota → Zod validation → transactional UPSERT match/players/draft → data revision increment → cache invalidation (снимки истории не мутировать).
4. Прогноз: API фиксирует scenario revision / input snapshot → feature builder as-of-cutoff → активная успешно прошедшая контроль модель → probability or unavailable → неизменяемый prediction run.

## Контракт отсутствующих данных

- `null` означает неизвестно или невозможно посчитать, `0` — подтверждённый ноль.
- Возвращать `sampleSize`, `coverage`, `source`, `computedAt`, `dataUpdatedAt`, `warnings`.
- User chooses team A/B; Radiant/Dire отдельное свойство сценария.
- При недоступном провайдере разрешён cache stale с предупреждением. Ни один endpoint не рисует фальшивые матчи.

## Security

Один владелец, пароль Argon2id, cookie HttpOnly/Secure в HTTPS/SameSite, server-side hash session token. Ограничить попытки входа; CSRF защита при cookie-auth; CORS exact allowlist; собственные URL для источников не принимать без проверки SSRF; доступ к синку только owner. В dev-окружении ограничить API на loopback.

## Нефункционально

Адекватный UX для desktop, устойчивость к пустой базе, структурированные логи без секретов, health, стабильные коды ошибок, Docker Postgres, migration checklist, воспроизводимый локальный запуск.

## Запланированные интерфейсы (НЕ реализованы в стартовом каркасе)

`ProviderAdapter`, `MatchImporter`, `TeamRepository`, `PlayerRepository`, `AnalysisService`, `ScenarioService`, `PredictionService`, `FeatureBuilder`, `ModelRegistry`. Реализовывать по этапам, не генерацией пустых типов под весь проект.

## Составы и замены

Наблюдаемое историческое участие — только `matches`+`match_players` (пятёрка одной стороны), независимая от организации. `team_roster_periods` и текущие API-флаги — подсказки, не подтверждения. Для анализа сценария храним `scenario_expected_lineup` (базовая конфигурация, optional) и `scenario_lineup` (выбранная пятёрка). Сравнение создает признаки сыгранности, но не вводит фиксированный penalization; те же функции feature builder применяются offline и online. Новые события трансферов не попадают в ретро-прогнозы. См. `docs/ROSTER_CONTINUITY.md`.

## P0 архитектурные инварианты: контекст, идентичность, время и оценка

Схема остаётся **одним** TypeScript backend + PostgreSQL, без дополнительных сервисов. Внутри backend выделяются чистые интерфейсы:

```text
OpenDota (optional STRATZ) -> ProviderAdapter/Zod
  -> SourceNormalizer + ProvenanceRecorder (known_at != fetched_at)
  -> PostgreSQL canonical maps / map_players / aliases / source snapshots
  -> IdentityResolver (verified accounts, aliases, as-of roster, roles)
  -> MatchContextResolver (series, map number, Radiant, first pick, draft order, hero availability)
  -> ProMatchRepository (as-of only, opponent strength)
  -> AnalyticsFeatureBuilder (point-in-time, patch-aware, role-aware, smoothed stats)
  -> Versioned DatasetBuilder (verified map labels, frozen as-of features)
  -> Offline Train / Calibrate / Evaluate (series grouped, chronological)
  -> Candidate ModelRegistry/QualityGate -> PredictionService (immutable snapshots)
  -> Verified PredictionOutcomeLinker -> Prospective Monitoring (P1)
```

**Граница доступа к данным:** UI никогда не получает сырой доступ к API провайдера; provider API → normalizer → validated canonical entities. История аккаунта переносится через `player_external_accounts` только после подтверждения, строковые ники не объединяют сущности. `match_field_observations` и `match_source_snapshots` фиксируют конфликты/провенанс, а nullable context не восстанавливается догадками. Самая важная гарантия — время события, историческая известность и дата загрузки не сливаются в одно.

**P0 с первого дня:** временная модель для cutoff, карта/серия разделены, сторона vs первый пик раздельно, verified 5+5 lineup и role assignment, opponent-adjusted strength, shrinkage/coverage, patch/hero availability, immutable forecasts (DB trigger блокирует изменения завершённых прогнозов; фактический исход прикрепляется отдельной записью). Два прогноза оценивают **карту**, без автоматического прогноза серии. Наличие схемы полей `venue_kind`, `draft_order_version` и `parent_scenario_id` не означает, что P1 features уже реализованы.

**P1 расширения через существующие границы:** Model Performance через `prediction_outcomes`, what-if с ссылкой `parent_scenario_id`, этап турнира/онлайн-LAN, полный порядок пиков/банов. P2: структурная оценка состава героев и независимая серия BO. См. `docs/POINT_IN_TIME_AND_MATCH_CONTEXT.md`, `docs/IDENTITY_AND_DATA_QUALITY.md`, `docs/MODEL_EVALUATION_AND_SCENARIOS.md`.

## P0 feedback-to-training foundation / P1 automated learning (MVP v4)

**Нормативная спецификация:** `docs/CONTINUOUS_LEARNING_PIPELINE.md`. Импорт завершённой pro-карты создаёт фактический исход **в канонической `matches`**. Training dataset builder формирует ровно один обучающий пример на `match_id` и stage, с frozen `as_of(T)` признаками из матчей до T. Сохранённый прогноз (`prediction_runs`) не является обучающей меткой и не размножает число обучающих матчей; verified `prediction_outcomes` — отдельный канал метрик реальных прогнозов.

**P0 архитектурно:** таблицы `training_dataset_versions`/`training_dataset_maps` → `model_training_runs` → `model_evaluation_runs` → `prediction_model_versions` → `model_activation_events`, новая **forward-only** миграция `005_training_pipeline.sql`, единственный point-in-time feature builder для offline/live, artifact SHA-256, reproducible freeze и независимая проверка кандидата. На старте обучение и активация выполняются управляемой offline CLI, не HTTP-запросом. До проверки новая модель остаётся inactive; предыдущая активная версия сохраняется.

**P1 функционально:** PostgreSQL-based scheduled jobs для новых eligible pro-карт / смены патча, challenger vs champion, evaluated prospective outcomes, просмотр динамики Brier/Log Loss/ECE и ручное подтверждение повышения версии. Автоматическая публикация только после отдельного opt-in + gate, атомарного CAS-switch и audit. Не расширять сервис до multi-tenant / SaaS.

```text
verified map/result -> canonical matches ─┬─> frozen training dataset -> training run -> candidate -> evaluator/gate -> registry
                                          └─> prediction_outcomes (P1) -> monitoring / drift
active model -> PredictionService -> immutable prediction_runs ────────────────┘
```

В `matches` winner может быть скорректирован на основании нового проверенного источника. Старые frozen datasets и predictions остаются историческими артефактами; новые версии создаются и оцениваются отдельно. Инварианты точности и список проверок — в `docs/CONTINUOUS_LEARNING_PIPELINE.md`.

## v5 — детальная инженерная спецификация и ограничения

**Нормативно:** [TECHNICAL_ARCHITECTURE_AND_STACK](TECHNICAL_ARCHITECTURE_AND_STACK.md), [ENGINEERING_PATTERNS](ENGINEERING_PATTERNS.md), [DATA_PIPELINE_DESIGN](DATA_PIPELINE_DESIGN.md), [ML_ENGINEERING_DECISIONS](ML_ENGINEERING_DECISIONS.md), [DEPLOYMENT_AND_TESTING](DEPLOYMENT_AND_TESTING.md), [DEPENDENCY_MATRIX](DEPENDENCY_MATRIX.md). Это **архитектурные решения**, не выполненная установка пакетов.

Сохраняется modular monolith: Fastify server (HTTP only), отдельный Node worker с `pg-boss` (PostgreSQL queue), API и worker используют одну БД и use cases; Redis и отдельный ML-inference HTTP-сервис исключены из MVP. TS baseline inference должен совпадать с offline Python `scikit-learn` fit/calibration по golden vectors. Историческая корректность `known_at` и условные реконструированные lineups подтверждаются отдельным availability/evaluation режимом; нельзя выдавать реконструкцию состава из финальных данных карты за заранее известный ростер.

## v9 — source integrity and capability-based ingestion (P0)

The normative contract is [DRAFT_DATA_INTEGRITY.md](DRAFT_DATA_INTEGRITY.md). Between `ProviderAdapter` and canonical facts, the normalizer MUST split three independently versioned paths:

```text
GET /matches/{id} -> match_source_snapshots (HTTP raw-ref/hash + fetched_at)
                 -> match_draft_source_observations (unaltered picks_bans[] / NULL)
                 -> match_players (5+5 slots, final played heroes)
                 -> match_quality_assessments (separate statuses + anomaly codes)
                 -> match_draft_actions (ONLY draft events validated by rule/policy)
                 -> feature-stage eligibility resolver (as-of policy + model stage)
```

Database schema: forward-only migration 006, historical migrations 001–005 immutable. Do not use one global `is_valid` field. Sources that have 10 final heroes but 0/11/12 `is_pick` remain eligible for appropriately validated *final hero* descriptive analytics, while sequence-based models require separately verified patch-/mode-specific order. Organization IDs and `series_id` may remain NULL; no reconstruction from present-day team membership. The importer/validator and model policy must be separately testable and versioned. `draft_order_valid=null` is unassessed, not a failed match.
