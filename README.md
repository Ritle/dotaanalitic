# Dota 2 Pro Analytics — Personal MVP / Codex Engineering Kit v9

Личный аналитический сервис профессиональной Dota 2: команды, игроки, история карт, Draft Lab, предматчевые и последрафтовые прогнозы **только после реальной проверки моделей**.

> **Статус:** репозиторий для старта разработки через Codex. В комплекте — полное ТЗ, план, SQL-схема и **минимальный запускаемый каркас**, но не готовое приложение с данными и прогнозами. Неисполненные функции описаны как задачи, а не имитированы фальшивыми данными.

Репозиторий: **[Ritle/dotaanalitic](https://github.com/Ritle/dotaanalitic)**. Для подключения Git в VS Code см. [инструкцию для Windows](docs/GIT_SETUP_WINDOWS.md).

## Быстрый старт

Требования: **Node.js 22+**, Corepack/pnpm 10+, Docker с Compose.

```bash
corepack enable
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm dev
```

На Windows PowerShell вместо `cp` можно использовать `Copy-Item .env.example .env`. После запуска: web `http://localhost:5173`, API `http://localhost:3000/health`. Запущенный каркас показывает технический статус API; Auth, сбор данных и аналитические страницы реализуются Codex по плану.

Файл `.env` содержит локальные секреты и **не коммитится**. Для установки владельца после реализации задачи S0-03 предусмотрена CLI-команда `pnpm owner:create` (на старте команда намеренно отсутствует, пока не реализован AuthService).

## Важные команды

```bash
pnpm dev                 # web + api в watch-режиме
pnpm build               # сборка рабочих пространств
pnpm typecheck           # проверка типов
pnpm test                # unit-тесты
pnpm db:up               # PostgreSQL
pnpm db:migrate          # применить все миграции 001→002→003→004→005→006
pnpm db:down             # остановить PostgreSQL, НЕ удалять volume
```

Отсутствует lockfile в стартовом архиве: запустите `pnpm install` один раз, затем **закоммитьте `pnpm-lock.yaml`**. На CI использовать `--frozen-lockfile`.

## Документация — порядок чтения Codex

1. `AGENTS.md` — правила агента и запреты.
2. `TECHNICAL_SPEC.md` — все утверждённые функциональные требования Personal MVP v2.
3. `docs/TECHNICAL_ARCHITECTURE_AND_STACK.md`, `docs/DEPENDENCY_MATRIX.md`, `docs/ENGINEERING_PATTERNS.md`, `docs/DATA_PIPELINE_DESIGN.md`, `docs/ML_ENGINEERING_DECISIONS.md`, `docs/DEPLOYMENT_AND_TESTING.md` — нормативные технические решения и паттерны; затем `docs/ARCHITECTURE.md` и `docs/SCREEN_SPECS.md` — компоненты, пользовательские экраны и потоки данных.
4. `docs/DATA_MODEL.md` + `packages/db/migrations/001..006` — хранение.
5. `docs/DATA_SOURCES.md` — OpenDota и ограничения.
6. `docs/API_CONTRACTS.md` — маршруты и форматы.
7. `docs/PREDICTION_ENGINE.md` и `docs/CONTINUOUS_LEARNING_PIPELINE.md` — антиутечка, backtest, frozen datasets, verified outcomes и безопасная публикация моделей.
8. `docs/IMPLEMENTATION_PLAN.md` и `docs/PRIORITY_TRACEABILITY.md` — задачи и матрица приоритетов.
   Нормативные дополнения: `docs/POINT_IN_TIME_AND_MATCH_CONTEXT.md`, `docs/IDENTITY_AND_DATA_QUALITY.md`, `docs/MODEL_EVALUATION_AND_SCENARIOS.md`.
9. `docs/ACCEPTANCE_CRITERIA.md` и `docs/TEST_PLAN.md` — проверка готовности.
10. `CODEX_START_PROMPT.md` — готовый первый запрос Codex.

## Основное правило точности

Про-аналитика строится только на подтверждённых профессиональных картах и только по данным **до момента прогноза**. Пока модель не обучена и не проверена, нельзя показывать проценты победы — только `прогноз недоступен` и объяснение.

## Полезные ссылки

- [OpenDota API](https://docs.opendota.com/)
- [OpenDota OpenAPI](https://opendota.apidocumentation.com/)
- [dotaconstants](https://github.com/odota/dotaconstants)


### Учёт патчей и точности прогнозов

Система принципиально различает статистику **строго на выбранном патче** и признаки **с пониженным весом старых матчей** для предиктивных моделей. Подробно — `docs/PATCH_AWARE_ANALYTICS.md`. При выходе нового патча и малом объёме данных post-draft прогноз может быть недоступен, это ожидаемое безопасное поведение.

### Составы и сыгранность (MVP 2.1)

Обязательный контракт: `docs/ROSTER_CONTINUITY.md`. Нельзя считать team tag синонимом одной пятёрки; личная история и совместные игры игроков сохраняются после трансферов. Stand-in анализируется как новый набор игроков/ролей, без фиксированного «штрафа» к проценту побед. Необязательная baseline пятёрка хранится в `scenario_expected_lineup` (`003_roster_continuity.sql`). Переобучение roster-aware модели — отдельный этап, новые pure functions предоставляют только проверяемые описательные метрики.

### Состав обновления v3 — новые игровые/статистические нюансы

Нормативная документация: `docs/IMPLEMENTATION_PLAN.md` (задачи с `[P0/P1/P2]`), `docs/POINT_IN_TIME_AND_MATCH_CONTEXT.md`, `docs/IDENTITY_AND_DATA_QUALITY.md`, `docs/MODEL_EVALUATION_AND_SCENARIOS.md`. Новый SQL `packages/db/migrations/004_context_identity_provenance.sql` задаёт хранилище для context/identity/provenance; **это не реализация импорта и моделей**. Вся разработка идёт последовательно, начиная с `S0-00`. Фундаментальные гарантии P0 должны работать до публикации win probabilities; P1/P2 не блокируют первоначальный личный сервис.

### Обновление v4 — архитектура дообучения

`docs/CONTINUOUS_LEARNING_PIPELINE.md` — обязательное P0 соглашение для Codex: новая проверенная pro-карта может участвовать в следующей версии обучающей выборки, но прогноз модели и выбор фаворита пользователем **не** являются правильными ответами. `005_training_pipeline.sql` добавляет frozen manifest/карты датасета, историю обучения/проверки/активации. Offline training и quality gate — P0; расписание, champion/challenger и опциональное (по умолчанию выключенное) autopromotion — P1. **Текущий архив — каркас и документация, обучение пока не реализовано.**

### Обновление v5 — инженерный стек, паттерны и сложные случаи

В дополнение к логике v4 добавлены **семь инженерных документов**. Выбран modular monolith + PostgreSQL `pg-boss` queue, SQL-first + типизированный Kysely, Vue Query для async-cache, Argon2id/DB sessions, Python sklearn для offline train и TypeScript для online logistic inference с golden parity тестами. Отдельно разобраны ретроспективное знание lineups, временная утечка, импорт at-least-once, historical series splits, artifact SHA, timeout/Retry-After, lock/транзакции, CSRF и backup/restore. Текущие starter `package.json` **не содержат новые библиотеки**: установка и проверка совместимости являются задачами Codex по этапам. Миграции 001–005 не менялись. См. [TECHNICAL_ARCHITECTURE_AND_STACK.md](docs/TECHNICAL_ARCHITECTURE_AND_STACK.md), [TECH_DECISION_REGISTER.md](docs/TECH_DECISION_REGISTER.md) и [CODEX_V5_TECH_UPDATE_PROMPT.md](CODEX_V5_TECH_UPDATE_PROMPT.md).

### Рекомендации Codex по переключению моделей (v6)

Codex должен кратко оценивать сложность выбранного этапа и **советовать** GPT-6.1 Sol или GPT-6 Astra и reasoning effort перед критическими изменениями; при возвращении к рутинной реализации — рекомендовать более лёгкий режим. Это **только текстовые подсказки**, фактическое переключение остаётся за владельцем. Правила в [CODEX_MODEL_ROUTING.md](docs/CODEX_MODEL_ROUTING.md) и `AGENTS.md`. Для существующего репозитория см. `CODEX_V6_MODEL_ROUTING_UPDATE_PROMPT.md`.


## v7 — готовность для Codex / Developer Experience & QA

Начните с **[CODEX_V7_START_PROMPT.md](CODEX_V7_START_PROMPT.md)**. Инструкция по запуску и сетевому blocker lockfile: [DEVELOPMENT_PREFLIGHT](docs/DEVELOPMENT_PREFLIGHT.md). Текущий снимок состояния: [PROJECT_STATE](docs/PROJECT_STATE.md).

Добавлены синтетические fixtures и golden tests, отдельный `node --test` suite без зависимостей, PostgreSQL 16 integration tests (после установки), Python scikit-learn demo candidate и JS/TS parity, Playwright bootstrap, CI, производственный Compose + Caddy/Dockerfiles и безопасные скрипты backup/restore.

Ключевое ограничение: **в архиве нет `pnpm-lock.yaml`, так как registry был недоступен во время подготовки**. Его необходимо реально сгенерировать через `node scripts/bootstrap-lockfile.mjs` (или `corepack pnpm install`) и закоммитить до успешного CI/production. Скрипты и Dockerfile преднамеренно не обходят frozen-lockfile gate.

```bash
node scripts/verify-migrations.mjs
node scripts/check-doc-links.mjs
node --test tests/node/*.test.mjs
# после npm install:
pnpm test:integration
pnpm test:e2e
```

Синтетическая ML модель предназначена только для проверки архитектуры и никогда не активируется в API.

### v8 Prediction data source specification

[docs/PREDICTION_DATA_SPEC.md](docs/PREDICTION_DATA_SPEC.md) lists concrete Pre-map/Post-draft raw fields, generated features, point-in-time availability rules and the `scripts/audit-prediction-sources.mjs` API audit. Run the audit on a networked machine; `--fixture tests/fixtures/opendota-audit-synthetic.json` verifies the script offline without measuring real data.

## v9 — Data Integrity: архитектура для аномальных матчей OpenDota

**Обязательное P0 соглашение:** [DRAFT_DATA_INTEGRITY.md](docs/DRAFT_DATA_INTEGRITY.md). Аудит 50 последних карт владельца показал неполные ID организаций/серий и 0/11/12 pick events в некоторых драфтах. Пять игроков и их финальные герои, события `picks_bans` источника и верифицированная хронология драфта — разные сущности; нельзя обрезать «лишние» пики или выбрасывать всю карту при повреждённой одной части. Схема дополнена **forward-only** миграцией `006_draft_data_quality.sql` (001–005 неизменны). В v9 аудитор выводит schema v2: `draft_order_valid=null` пока не проверены правила патча/режима.

```bash
node --test tests/node/*.test.mjs
node scripts/audit-prediction-sources.mjs --fixture tests/fixtures/opendota-audit-anomalies-synthetic.json --sample 6
node scripts/verify-migrations.mjs
```

Новые компоненты пока не означают, что нормализатор/данные БД уже работают: PostgreSQL тесты и реальный повторный аудит остаются обязательными для Codex.
