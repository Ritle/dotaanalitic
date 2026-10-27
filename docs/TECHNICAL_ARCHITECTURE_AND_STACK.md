# Техническая архитектура и выбор библиотек — v5

**Статус:** нормативный engineering decision document для Codex. **Не означает, что перечисленные пакеты уже установлены или функции реализованы.** Предыдущие `001..005` SQL-миграции нельзя править; внедрение библиотек делать последовательно в задачах плана. Основные спецификации: [ARCHITECTURE](ARCHITECTURE.md), [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md), [CONTINUOUS_LEARNING_PIPELINE](CONTINUOUS_LEARNING_PIPELINE.md).

## 0. Приоритеты и non-goals

- **P0:** достоверные, воспроизводимые pro-only данные и map-level prediction; один владелец, один сервер/VPS; архитектурные границы, типы, миграции, история экспериментов.
- **P1:** плановые импорты/переобучение, what-if, Model Performance, турнирный контекст, наблюдаемость.
- **P2:** series prediction, live, сложные стили драфтов, коммерческий SaaS — НЕ строить заранее.
- **Принцип:** modular monolith + выделенный worker process (одно приложение/репозиторий и одна БД); только офлайн Python CLI для обучения по мере необходимости, **без** ML HTTP-микросервиса, Kafka, Redis, Kubernetes, feature store SaaS.

## 1. Каноническая схема развертывания

```text
Browser (Vue 3 + TS + Vue Query)
  | same-origin HTTPS, HttpOnly owner session
  v
Nginx/Caddy -> Fastify v5  [route -> use case -> repository/provider ports]
                         |                 |
                         |                 +--> OpenDota adapter (STRATZ opt-in)
                         v
                     PostgreSQL 16
                         ^
                         |
                pg-boss worker (import, refresh, aggregates, training orchestration)
                         |
                frozen dataset/manifest -> Python training CLI (offline)
                         |
              audited model candidate JSON -> gate -> atomic model registry
                         |
                   Node TypeScript logistic inference (same feature schema)
```

HTTP-запрос **не** скачивает тысячи карт, не пересчитывает глобальную мету и не запускает обучение. Задача импорта — очередью; read endpoint возвращает локальную статистику с `freshness`/`coverage` и возможным `syncJobId`.

## 2. Стек и библиотеки: решение, причина и момент внедрения

| Область | Выбор | Причина / нюанс | Этап |
|---|---|---|---|
| Runtime / workspace | Node.js **22 LTS**, TypeScript strict, `pnpm` workspaces | Одинаковый TS для API/feature-engineering; Node/npm/pnpm и lockfile закрепить при bootstrap | S0-00 P0 |
| Frontend | Vue 3 Composition API + Vite + Vue Router | Поддерживает интерактивный Draft Lab; не нужен Nuxt/SSR в личном кабинете | S0-00 P0 |
| Server state | **`@tanstack/vue-query`** | Ключи кеша, stale/retry/invalidation для сетевых данных. Pinia **только** auth/UI draft editing; не копировать туда server cache | S1-01 P0 |
| API | **Fastify 5** plugins + **Zod 4** | Быстрый typed route boundary; `@fastify/type-provider-zod` после compatibility smoke с установленной Zod (см. note ниже) | S0-00 / S0-01 P0 |
| DTO validation | `zod` в `packages/contracts`; branded ID только на уровне кода | Строковые BIGINT и ISO-UTC в JSON, nullable; реальные provider payload — собственная versioned Zod boundary | S0-01 P0 |
| DB driver | `pg` (node-postgres) + **Kysely** по мере появления сложных репозиториев | SQL-first schema **сохраняем**; Kysely — для type-safe запросов/транзакций, а не альтернативный мигратор | S0-02 P0 |
| DB schema migrations | Существующий `scripts/migrate.mjs` + immutable `001..005` | Один источник DDL, checksum + advisory lock; не использовать одновременно `drizzle-kit push`/`prisma migrate` | S0-00 P0 |
| Durable jobs | **`pg-boss`**, PostgreSQL-backed, без Redis | Повторы/lease/at-least-once/cron; отдельная process роль worker, идемпотентность обязательна | S0-02 P0 / S5-06 P1 |
| External HTTP | Node built-in `fetch` / AbortSignal + самостоятельно ограниченный concurrency | Меньше лишних библиотек; backoff для 429/503/timeout, `Retry-After`, ограничение запросов на один provider; отдельный `ProviderTransport` | S0-01 P0 |
| Auth | `argon2` (Argon2id), `@fastify/cookie`, `@fastify/csrf-protection`, `@fastify/rate-limit` | Single-owner, server-side opaque sessions с хэшем токена в БД; **не** JWT/localStorage; проверять major-совместимость plugin/Fastify | S0-03 P0 |
| UI charts | `echarts` + `vue-echarts` | Динамические графики patch/drift/probability; lazy load тяжёлых страниц | S1/S3 P0 |
| Forms | `zod` + Vue reactive state; по необходимости `vee-validate` | Не вводить дополнительную form-библиотеку до сложных валидаций | S2-01 P0 (optional) |
| Unit / API test | Vitest, Fastify `inject`, `@vue/test-utils` | Быстрые детерминированные тесты чистых вычислений/HTTP без сети | S0-00 P0 |
| DB integration | Testcontainers **при наличии Docker**, иначе Compose test DB | Нужны реальные PostgreSQL constraints, transactions, SQL миграции | S0-00/S0-02 P0 |
| E2E | `@playwright/test` | Проверка auth→scenario→draft→unavailable/probability; не мокировать БД для критического пути | S4-02 P0 |
| Logs | Fastify Pino + Node `performance` | Request ID, correlation ID, job ID; исключить secrets, cookies, tokens | S0/S4 P0 |
| Metrics | Простые DB/worker counters + health/readiness; позже Prometheus | Не тащить OpenTelemetry stack раньше потребности | S4-03 P0 / P1 |
| Baseline ML | **Python 3.12 + `numpy`, `pandas` (offline), `scikit-learn`** | Проверенная логистическая регрессия, калибровка, evaluation; CPU без GPU | S3-03 P0 |
| Online inference | Чистый TS в `packages/prediction` по экспортированным JSON коэффициентам и preprocess metadata | Убрать Python из горячего HTTP-пути; **parity test TS vs Python обязательный** | S3-03 P0 |
| Enhanced ML | `catboost` **после baseline** и доказанного прироста | Категориальные признаки и взаимодействия; требует продуманного serving (не подменять TS-модель без адаптера) | P1/P2, по решению |
| Training artifact | JSON manifest + sha256 + файловое хранилище на VPS, модель registry в PostgreSQL | Версионирование, атомарная публикация, backup; не хранить тяжёлые pickles как доверенный runtime artifact | S3-03 P0 |

**Совместимость:** официальные тип-провайдеры Fastify для Zod существуют, но современные варианты требуют определённой Zod 4.x; текущая заготовка содержит `zod: ^4.1.0`. Codex должен после `pnpm install` проверить реальную резолюцию, peer deps и выбрать **одну** совместимую пару с lockfile (при необходимости обновить Zod). Не ставить вслепую одновременно community `fastify-type-provider-zod` и `@fastify/type-provider-zod`. Целевые версии фиксировать **при S0-00**, когда CI подтвердит сборку; текущие пакеты starter — отправная точка, не утверждение о последних стабильных версиях.

**Kysely vs Drizzle/Prisma:** Kysely подходит существующим hand-written forward-only SQL-миграциям и сложным запросам для cohort/temporal analytics. Типы DB надо получать из схемы с type generation или сопровождать проверяемыми типами; Kysely проверяет TS, но не является runtime validator. Drizzle тоже возможен, но смешивать два независимых генератора миграций нельзя. Prisma отклонён для MVP из-за высокой доли аналитического SQL и уже существующего SQL-first репозитория.

## 3. Модули modular monolith

| Модуль / папка | Ответственность | Не должен делать |
|---|---|---|
| `apps/api/src/modules/auth` | Session/auth CLI/CSRF | Хранить пароли/токены в логах |
| `apps/api/src/modules/ingestion` | Provider jobs, contract adapters, idempotent UPSERT | Считать winrate из неотфильтрованных pub matches |
| `apps/api/src/modules/catalog` | Teams, players, patch/hero registry, canonical identities | Склеивать игроков по нику |
| `apps/api/src/modules/scenarios` | Editable scenario + revision; immutable analysis/prediction snapshots | Менять завершённые прогнозы |
| `apps/api/src/modules/analytics` | Use cases + repositories, `asOf` запросы | Читать внешние API в запросе отчёта |
| `packages/analytics` | Чистые stats/shrinkage/pairs/Elo/decay | SQL, HTTP, глобальное состояние |
| `packages/prediction` (позднее) | Feature contracts, trained JSON inference, quality gate, ML CLI manifest | Переобучать на каждом пользовательском запросе |
| `packages/db` | Transaction boundary, SQL repositories, migrations | Применять DDL из HTTP-хендлера |
| `apps/worker` (создать на S0-02) | pg-boss consumers, retry, import + P1 retrain scheduling | Отвечать за auth/HTTP route |
| `ml/` (создать на S3) | Offline Python fit/calibrate/evaluate/export | Сервис inference в сети |

**Зависимости:** `web -> contracts`; `api -> contracts, analytics, db, prediction`; `worker -> db + providers + use cases`; `prediction` зависит только от contracts/features и портов чтения, не от Fastify/HTTP. Недопустимы циклы. Не создавать многослойную папочную иерархию ради одного endpoint; начинать с вертикальных slices.

## 4. Строгие базовые контракты

- Время в БД `timestamptz` UTC; входные даты — ISO 8601 с offset. `asOf` — явный параметр; никакого `new Date()` глубоко в чистых расчётах: Clock внедряется отдельно.
- ID карт/игроков как `string` на JSON-boundary; в БД `bigint`, runtime `pg` обычно выдаёт `int8` строкой; запрет `Number(match_id)`.
- День/патч вычисляется по **моменту начала карты** и подтверждённому registry, не по дате загрузки. Изменение registry = новая `data_revision` и invalidation аналитических агрегатов.
- Никакого скрытого fallback `0.5`, `0%`, `is_pro=true`, предположенных current roster/roles. `status`, `reasons`, `coverage`, `sampleSize`, `computedAt`, `modelVersion` обязательны для зрелого результата.
- Ошибки: `validation_error`, `unauthorized`, `source_unavailable`, `insufficient_data`, `model_unavailable`, `conflict`, `rate_limited`. HTTP 409 для конфликтов ревизии, 202 для фоновой задачи; `Retry-After` по ситуации.
- Query cache key должен включать `resource`, IDs, scenario revision, `asOf`, patch filter, `data_revision`, model version при необходимости; immutable snapshots могут иметь `staleTime: Infinity`.

## 5. Что отклоняем до появления реальных нагрузок

Не использовать Redis/BullMQ параллельно pg-boss; Kafka/RabbitMQ; GraphQL для собственного API; глобальный Nx/Turborepo только из-за моды; CQRS/Event Sourcing framework, абстрактные generic repositories на все сущности, MLflow server, Spark, Spark Streaming, GPU, Kubernetes. Встроенные чистые порты и строгие схемы позволят заменить решения позже.

## 6. Перекрёстные спецификации

- [ENGINEERING_PATTERNS](ENGINEERING_PATTERNS.md) — DI, порты/адаптеры, state machine, concurrency, ошибки.
- [DATA_PIPELINE_DESIGN](DATA_PIPELINE_DESIGN.md) — temporal data, import pipeline, provider conflict, indexes, snapshots.
- [ML_ENGINEERING_DECISIONS](ML_ENGINEERING_DECISIONS.md) — feature parity, обучение/калибровка, gate и cold patch.
- [DEPLOYMENT_AND_TESTING](DEPLOYMENT_AND_TESTING.md) — deployment, безопасность, CI, тесты, ресурсы.
- [TECH_DECISION_REGISTER](TECH_DECISION_REGISTER.md) — ADR и границы неизменности.

## Официальные источники (проверены при подготовке документа 2026-10-27)

- https://fastify.dev/docs/latest/Reference/Type-Providers/
- https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/
- https://tanstack.com/query/latest/docs/framework/vue/guides/important-defaults
- https://kysely.dev/docs/getting-started
- https://pgboss.io/introduction
- https://scikit-learn.org/stable/modules/calibration.html
- https://docs.opendota.com/
