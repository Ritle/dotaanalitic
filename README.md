# Dota 2 Pro Analytics — Personal MVP / Codex Engineering Kit v9

Личный аналитический сервис профессиональной Dota 2: команды, игроки, история карт, Draft Lab, предматчевые и последрафтовые прогнозы **только после реальной проверки моделей**.

> **Статус:** реализованы локальные справочники, расписание, описательная аналитика, ручные сценарии/Draft Lab и версии отчётов. Прогнозные модели пока недоступны: empirical source/model gates остаются открытыми. Точное состояние — [PROJECT_STATE](docs/PROJECT_STATE.md).

Репозиторий: **[Ritle/dotaanalitic](https://github.com/Ritle/dotaanalitic)**. Для подключения Git в VS Code см. [инструкцию для Windows](docs/GIT_SETUP_WINDOWS.md).

## Быстрый старт

Для уже настроенного Windows checkout см. [короткий путь к первому входу](docs/S1_19_LOCAL_STARTUP.md). Существующую `.env` и PostgreSQL не переинициализировать.

Требования: **Node.js >=22.12.0**, Corepack/pnpm **10.19.0**, PostgreSQL 16 (обычно Docker с Compose).

```bash
corepack enable
cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate
pnpm owner:create
pnpm dev
```

На Windows PowerShell вместо `cp` можно использовать `Copy-Item .env.example .env`. Замените пароль в `POSTGRES_PASSWORD` и `DATABASE_URL` согласованно до запуска БД. API при `dev`/`start`, мигратор и integration-тесты читают корневую `.env`; переменные процесса имеют приоритет. После запуска: web `http://localhost:5173`, API `http://localhost:3000/health`. До входа доступна форма владельца; после входа — справочники, описательные отчёты, расписание и сценарии. Открывайте web точно по `WEB_ORIGIN` (localhost и 127.0.0.1 — разные Origin). Для обновления истории из интерфейса запустите **`pnpm worker:dev` во втором терминале**; кнопка находится на странице организации. Нужна текущая миграция021.

Файл `.env` содержит секреты и **не коммитится**. `pnpm owner:create` запускайте в локальном терминале: логин + два скрытых ввода пароля (12–128 символов). Второй аккаунт запрещён. Сброс: `pnpm owner:reset --login YOUR_LOGIN`, с отзывом всех сессий. Пароль не передавать аргументом командной строки. [Контракт, stdin-режим и проверки S0-03](docs/S0_03_OWNER_AUTH.md).

## Важные команды

```bash
pnpm dev                 # web + api в watch-режиме
pnpm build               # сборка рабочих пространств
pnpm typecheck           # проверка типов
pnpm test                # unit-тесты
pnpm test:auth           # авторизация на PG, отдельная временная БД
pnpm test:e2e            # Chromium + реальный API/PG, нужны CREATEDB
pnpm owner:create       # единственный владелец, скрытый ввод пароля
pnpm owner:reset --login YOUR_LOGIN # сброс пароля и отзыв сессий
pnpm provider:spike      # ограниченная проверка OpenDota, без записи матчей в БД
pnpm provider:audit --sample 20 --out reports/opendota-coverage.json # live coverage, нужны БД и сеть
pnpm worker:dev          # постоянный worker pg-boss, отдельный терминал
pnpm ingest:enqueue --match-id 9069021061 # поставить карту в durable очередь
pnpm ingest:once --match-id 9069021061    # поставить и дождаться одной задачи
pnpm test:ingestion      # импорт/очередь в отдельных временных БД, нужны права CREATEDB
pnpm db:up               # PostgreSQL
pnpm db:migrate          # применить все миграции 001–022
pnpm db:down             # остановить PostgreSQL, НЕ удалять volume
```

Сохранённые объявления о встрече на прошедший момент можно проверить локально:
`pnpm schedule:evidence 1756304 2026-11-01T17:12:24.000Z .tools/upcoming-evidence.json`.
Команда создаёт новый отчёт из БД; `observed` подтверждает наличие снимков расписания/заявки, а состав конкретной карты ещё требует проверки. [Правила чтения](docs/S1_08_PROSPECTIVE_SOURCE_EVIDENCE.md).

Качество уже импортированных pro-карт по турнирам, патчам и месяцам:
`pnpm corpus:quality 2000-01-01T00:00:00.000Z 2026-11-01T17:44:00.000Z .tools/corpus-quality.json`.
Отчёт сохраняет независимые статусы исходов, игроков, героев, организаций, серий и драфта, включая неизвестные данные. [Контракт и измерения](docs/S1_08_CORPUS_QUALITY.md).

Для проверенной привязки карт к числовым source series ID: `pnpm series:provision preview request.json new-plan.json`, затем `pnpm series:provision apply request.json <fingerprint-из-плана> new-result.json`. После регистрации штатный importer повторно обрабатывает reviewed captures. [Конфиг, проверки, миграция022 и ограничения](docs/S1_08_SERIES_PROVISION.md).

Для явно выбранных numeric accounts вне зависимости от нынешней команды: `pnpm accounts:current preview source.json selection.json new-plan.json`, затем `pnpm accounts:current apply source.json selection.json plan.json <SHA256-файла-плана> new-result.json`. [Формат, evidence и ограничения](docs/S1_08_CURRENT_ACCOUNTS.md).

`pnpm-lock.yaml` создан из registry при S0-00. Локально и в CI используйте `--frozen-lockfile`. Результаты проверок и запуск на Windows без глобальной установки pnpm описаны в [отчёте S0-00](docs/S0_00_VERIFICATION.md). При уже запущенном нативном PostgreSQL шаг `pnpm db:up` не нужен.

## Документация — порядок чтения Codex

1. `AGENTS.md` — правила агента и запреты.
2. `TECHNICAL_SPEC.md` — все утверждённые функциональные требования Personal MVP v2.
3. `docs/TECHNICAL_ARCHITECTURE_AND_STACK.md`, `docs/DEPENDENCY_MATRIX.md`, `docs/ENGINEERING_PATTERNS.md`, `docs/DATA_PIPELINE_DESIGN.md`, `docs/ML_ENGINEERING_DECISIONS.md`, `docs/DEPLOYMENT_AND_TESTING.md` — нормативные технические решения и паттерны; затем `docs/ARCHITECTURE.md` и `docs/SCREEN_SPECS.md` — компоненты, пользовательские экраны и потоки данных.
4. `docs/DATA_MODEL.md` + `packages/db/migrations/001..013` — хранение.
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

В дополнение к логике v4 добавлены **семь инженерных документов**. Выбран modular monolith + PostgreSQL `pg-boss` queue, SQL-first + типизированный Kysely, Vue Query для async-cache, Argon2id/DB sessions, Python sklearn для offline train и TypeScript для online logistic inference с golden parity тестами. Отдельно разобраны ретроспективное знание lineups, временная утечка, импорт at-least-once, historical series splits, artifact SHA, timeout/Retry-After, lock/транзакции, CSRF и backup/restore. В исходном starter новые библиотеки были planned; в S0-02 установлены и проверены Kysely и pg-boss. Остальные библиотеки внедряются только по своим этапам. Миграции 001–005 не менялись. См. [TECHNICAL_ARCHITECTURE_AND_STACK.md](docs/TECHNICAL_ARCHITECTURE_AND_STACK.md), [TECH_DECISION_REGISTER.md](docs/TECH_DECISION_REGISTER.md) и [CODEX_V5_TECH_UPDATE_PROMPT.md](CODEX_V5_TECH_UPDATE_PROMPT.md).

### Рекомендации Codex по переключению моделей (v6)

Codex должен кратко оценивать сложность выбранного этапа и **советовать** GPT-6.1 Sol или GPT-6 Astra и reasoning effort перед критическими изменениями; при возвращении к рутинной реализации — рекомендовать более лёгкий режим. Это **только текстовые подсказки**, фактическое переключение остаётся за владельцем. Правила в [CODEX_MODEL_ROUTING.md](docs/CODEX_MODEL_ROUTING.md) и `AGENTS.md`. Для существующего репозитория см. `CODEX_V6_MODEL_ROUTING_UPDATE_PROMPT.md`.


## v7 — готовность для Codex / Developer Experience & QA

Начните с **[CODEX_V7_START_PROMPT.md](CODEX_V7_START_PROMPT.md)**. Инструкция по запуску и сетевому blocker lockfile: [DEVELOPMENT_PREFLIGHT](docs/DEVELOPMENT_PREFLIGHT.md). Текущий снимок состояния: [PROJECT_STATE](docs/PROJECT_STATE.md).

Добавлены синтетические fixtures и golden tests, отдельный `node --test` suite без зависимостей, PostgreSQL 16 integration tests (после установки), Python scikit-learn demo candidate и JS/TS parity, Playwright bootstrap, CI, производственный Compose + Caddy/Dockerfiles и безопасные скрипты backup/restore.

В исходном архиве v7 lockfile отсутствовал из-за недоступного registry. В S0-00 настоящий `pnpm-lock.yaml` создан и проверен через frozen install; скрипты и Dockerfile сохраняют frozen-lockfile gate. Миграции, integration и браузерный smoke выполнены локально; Docker production build и удалённый GitHub Actions ещё не запускались.

```bash
node scripts/verify-migrations.mjs
node scripts/check-doc-links.mjs
node --test tests/node/*.test.mjs
# после pnpm install --frozen-lockfile:
pnpm test:integration
pnpm test:e2e
```

Синтетическая ML модель предназначена только для проверки архитектуры и никогда не активируется в API.

### v8 Prediction data source specification

[docs/PREDICTION_DATA_SPEC.md](docs/PREDICTION_DATA_SPEC.md) lists concrete Pre-map/Post-draft raw fields, generated features, point-in-time availability rules and the `scripts/audit-prediction-sources.mjs` API audit. Run the audit on a networked machine; `--fixture tests/fixtures/opendota-audit-synthetic.json` verifies the script offline without measuring real data.

S0-01: [live-проверка OpenDota](docs/S0_01_PROVIDER_SPIKE.md), Zod provider boundary, timeout/retry/rate budget и пять обезличенных fixtures. Отчёт по 20 недавним картам сохранён как public coverage evidence; это не исторический backtest и не готовый importer.

## v9 — Data Integrity: архитектура для аномальных матчей OpenDota

**Обязательное P0 соглашение:** [DRAFT_DATA_INTEGRITY.md](docs/DRAFT_DATA_INTEGRITY.md). Аудит 50 последних карт владельца показал неполные ID организаций/серий и 0/11/12 pick events в некоторых драфтах. Пять игроков и их финальные герои, события `picks_bans` источника и верифицированная хронология драфта — разные сущности; нельзя обрезать «лишние» пики или выбрасывать всю карту при повреждённой одной части. Схема дополнена **forward-only** миграцией `006_draft_data_quality.sql` (001–005 неизменны). В v9 аудитор выводит schema v2: `draft_order_valid=null` пока не проверены правила патча/режима.

```bash
node --test tests/node/*.test.mjs
node scripts/audit-prediction-sources.mjs --fixture tests/fixtures/opendota-audit-anomalies-synthetic.json --sample 6
node scripts/verify-migrations.mjs
```

S0-02 (+ S0-10): нормализатор и durable очередь реализованы; новая миграция 007 применена, повторный импорт реальной карты проверен. Команды выше автоматически собирают shared packages; после правок `packages/db`/`packages/ingestion` перезапускайте worker. Границы, тесты и live evidence: [S0_02_INGESTION.md](docs/S0_02_INGESTION.md). Одна импортированная карта не является готовой обучающей выборкой или проверкой модели.

### S0-04 — исторический контекст

Типизированные наблюдения и чтение по cutoff/stage реализованы в `@dota/db`, без подстановки исторического knowledge из завершённой карты. Проверка: `pnpm test:temporal` (PG16/CREATEDB). [Контракт и ограничения](docs/S0_04_TEMPORAL_CONTEXT.md).

### S0-05 — идентичности и составы

Verified account evidence, aliases, cross-org история участия и lineup/role gates реализованы; importer использует общий identity resolver. Перед новым worker выполнить миграцию 010; проверка: `pnpm test:identity`. [Контракт и ограничения](docs/S0_05_IDENTITY_LINEUP.md).

### S0-06 — контекст карты и правила героев

GameContextRepository читает evidence-backed patch/mode/league, стороны и hero eligibility на cutoff. Неизвестные правила остаются null; версия ruleset не подтверждает фактический draft timeline. Требуется миграция 011; проверка: `pnpm test:game-context`. [Контракт и ограничения](docs/S0_06_GAME_CONTEXT.md).

### S0-07 — проверенные метки и заморозка датасетов

DatasetRepository вычисляет label из подтверждённой карты и source receipt, сохраняет отдельные features, защищает terminal snapshots и целые серии. Требуется миграция 012; проверка: `pnpm test:dataset`. Frozen snapshot ещё не означает допустимость признаков для обучения; DatasetBuilder остаётся S3-00. [Контракт](docs/S0_07_VERIFIED_DATASETS.md).

### S0-08 — live-аудит источника

Проверены 40 карт: 20 recent и по 5 четырёх исторических TI-лиг. Сохранены public flags/source hashes и HTTP counters, без raw payload/profile data. Новый `--league <id>` выбирает time ranks; canonical identity и historic known-at остаются unknown. [Результат и команды](docs/S0_08_SOURCE_AUDIT.md).

### S0-09 — готовность контекста на cutoff

DataReadinessRepository оценивает strict, owner-asserted и conditional-lineup cohorts с явными required/assumed facts. Завершённый roster не подставляется автоматически; ready относится только к контексту, training/prediction eligibility не оцениваются. Требуется миграция 013: серверный recorded_at защищает owner assertions от датирования задним числом. Проверка: `pnpm test:readiness`. [Контракт](docs/S0_09_DATA_READINESS.md).

### S1-01 — локальные справочники и обзоры

После входа главная страница ищет teams/players/heroes по имени, тегу или ID и показывает известную дату синхронизации. Обзоры `/teams/:id` и `/players/:id` различают организацию, исторический фактический состав карты и личность игрока; актуальный состав не угадывается. Поиск читает только локальную БД, новые данные загружаются отдельным importer/queue workflow; кнопка «Перечитать базу» не вызывает OpenDota. Vue Query установлен, cache очищается при выходе/401. Проверки: `pnpm test:catalog`, `pnpm test:e2e`. [Контракт и границы](docs/S1_01_CATALOGUE.md).

### S1-02 — профессиональные карты и фильтры

Обзоры команды и игрока показывают последние 10/20/50/100 завершённых pro-карт с фильтрами UTC периода, проверенного патча, соперника, турнира, стороны и подтверждённой роли выбранного игрока. Raw N/WR, полнота identity/roster/series/patch и неизвестные значения видны отдельно. Это текущее ретроспективное описание, не model features или вероятность победы. Проверки: `pnpm test:pro-maps`, `pnpm test:e2e`. [Контракт](docs/S1_02_PRO_MAPS.md).

### S1-03 — состав и замены

На странице команды задайте пять canonical ID игроков по ролям 1–5, optional базовую пятёрку и период UTC. Расчёт показывает точную пятёрку и десять исторических пар через любые организации, личную историю/подтверждённые роли и смены фактического состава организации. Непроверенные личности остаются неизвестными; новый состав не наследует победы старого. Stand-in — ручная пометка без фиксированного штрафа. Ввод пока не сохраняется: сценарии с ревизиями — S2-01. Проверки: `pnpm test:roster`, `pnpm test:e2e`. [Контракт](docs/S1_03_ROSTER_COHESION.md).

### S1-04 — игрок, герой и позиция

На странице игрока добавлена статистика по hero×confirmed role: pro-карты/победы, KDA, средние K/D/A и GPM/XPM с собственным N каждого поля, частота выбора и последняя карта. Default — проверенный патч среза и 90 дней; если патч неизвестен, выберите режим явно. Смена позиции создаёт отдельную строку, неподтверждённая роль остаётся неизвестной. Проверки: `pnpm test:player-hero`, `pnpm test:e2e`. [Контракт и знаменатели](docs/S1_04_PLAYER_HERO.md).

### S1-05 — хронологический Elo и сила соперников

На странице команды добавлен экспериментальный рейтинг на основе истории игроков пятёрки. Он показывает силу соперника до каждой карты рядом с raw WR организации; результат учитывается только после доказанной доступности. Период ограничивает отчёт, сохраняя раннюю историю для рейтинга. Без исторических identity/pro/outcome/lineup proofs рейтинг остаётся неизвестным; вероятности не публикуются. Проверки: `pnpm test:strength`, `pnpm test:e2e`. [Алгоритм, строгие gates и ограничения](docs/S1_05_CHRONOLOGICAL_ELO.md).

### S1-06 — размер выборки и сглаживание

Отчёты показывают категории raw N и холодный старт без процентов достоверности. В player×hero×role отдельно выводятся raw WR, экспериментальная сглаженная частота и объём/источник prior из раннего сопоставимого pro-пула. Unknown context/series и недостаточный reference не создают скрытого50/50. Текущие отчёты не взвешены; Kish N_eff реализован для явно заданных весов. Проверки: `pnpm test:sample`, `pnpm test:e2e`. [Формулы, границы и ограничения](docs/S1_06_SAMPLE_EVIDENCE.md).

### S1-07 — patch transfer foundation (P0 gate ещё открыт)

После `pnpm db:migrate` доступен внутренний реестр подтверждённых переходов патчей/изменений героев и экспериментальный расчёт раздельных весов draft/strength. `pnpm patch:history readiness` показывает реальные metadata/data prerequisites; `weights input.json` рассчитывает веса, `evaluate input.json` сравнивает три политики на явном temporal cohort. Production defaults отсутствуют, raw UI не меняется. Проверки: `pnpm test:patch-history`; synthetic результаты не доказывают реальное качество. До реального source/as-of coverage и chronological ablation S1-07 остаётся открытой. [Контракт и формат](docs/S1_07_PATCH_TRANSFER.md).

`pnpm patch:sources --patch '7.34c,7.34d,7.34e' --out reports/new-capture.json` выполняет bounded read-only аудит первичных Valve/Steam источников. Реальный capture выявил расхождения timestamps: их нельзя автоматически переносить в verified release registry. [Результат, SHA и ограничения](docs/S1_07_SOURCE_EVIDENCE.md).

`pnpm patch:archive --event '3735230544064408127' --out docs/evidence/new-announcement.json` проверяет CDX/Memento и содержимое архивного анонса. Для5 TI2023 map IDs подтверждена ранняя доступность текста, без подмены release/hero/outcome proof. [Архивный checkpoint](docs/S1_07_ARCHIVED_BODY.md).

### S1-08 — сравнение двух команд

Откройте «Сравнить две команды» из кабинета или организации, задайте два ID, период и при необходимости две пятёрки. Raw WR организаций, точные составы через любые теги, стороны и реальные H2H показаны отдельно; экспериментальный Elo соперников имеет собственный явно обозначенный cohort. Пустые личности/патчи остаются неизвестными, старые победы не присваиваются новой пятёрке, прогнозов нет. Проверки: `pnpm test:compare`, `pnpm test:e2e`. [Контракт и пределы](docs/S1_08_TEAM_COMPARE.md).

### S2-01 — сохранение сценариев

После `pnpm db:migrate` (текущая019) откройте «Сохранённые сценарии». Выберите две организации и вручную задайте10 разных canonical player IDs из локального каталога с ролями1–5; optional expected five и контекст одной карты сохраняются вместе. Пустые сторона/первый пик/серия остаются неизвестными. Подтверждение владельца относится к гипотезе; запись сегодня не доказывает историческую доступность состава. Каждое сохранение создаёт неизменяемую редакцию, конфликт двух вкладок сохраняет ваши правки в форме до явной загрузки актуальной версии. Проверки: `pnpm test:scenarios`, `pnpm test:e2e`. Прогнозы пока недоступны. [Контракт](docs/S2_01_SCENARIOS.md).

### S2-02 — Draft Lab

В редакторе сценария или `/scenarios/:id/draft` назначьте0–10 героев игрокам/ролям и при необходимости добавьте баны. Имена ищутся в локальном каталоге. «Проверить доступность героев» показывает источники/даты, подтверждённый запрет или явное unknown при неизвестном патче/лиге/начале карты. Сохранение повторяет проверку: известный запрет отклоняется422 без изменения редакции, unknown сохраняется с предупреждением. История хранит исходный драфт и результат проверки на момент сохранения. Полный порядок драфта и вероятности ещё недоступны. Проверки: `pnpm test:draft`, `pnpm test:e2e`. [Контракт](docs/S2_02_DRAFT_LAB.md).

### S2-03 — пары героев

После сохранения драфта выберите «Рассчитать пары»: союзные пары A/B и матрица A → B используют завершённые pro-карты строго до среза сценария. Для каждой пары показаны N, наблюдаемый WR, ранняя опорная выборка и качество данных. Это общая статистика героев, не прогноз выбранных игроков/команд. Веса выключены по умолчанию; явно заданные коэффициенты остаются экспериментальными, а недостаток подтверждений даёт unavailable. S1-07 и прогнозы остаются заблокированными. Проверки: `pnpm test:hero-matchups`, `pnpm test:e2e`. [Контракт и пределы](docs/S2_03_HERO_PAIRS.md).

### S2-04 — сохранённые отчёты

После `pnpm db:migrate` (текущая019) откройте «Открыть отчёты сценария», задайте период/патч/лигу и выберите «Рассчитать и сохранить отчёт». Каждая версия сохраняет редакцию ввода, организации/пятёрки, player×hero по подтверждённым историческим ролям, meta героев, пары/матрицу, источники и покрытие. Сырые и экспериментальные скорректированные показатели имеют собственные выборки; прогнозы недоступны. История остаётся неизменной после новых данных или редактирования сценария. Проверки: `pnpm test:reports`, `pnpm test:e2e`. [Контракт](docs/S2_04_SCENARIO_REPORTS.md).

### S3-00 — подготовка датасетов

После `pnpm db:migrate` (текущая019) используйте `pnpm dataset:prepare preview config.json`, затем `build config.json`. Strict as-of context и проверенный исход сохраняются отдельно; неизвестные составы/патчи/серии исключаются. Пустая выборка даёт unavailable без новых записей. Повтор одинакового build использует прежний frozen ID; `export <dataset-uuid> output.json` проверяет SHA и сохраняет точные bytes без перезаписи файла. Это prepared-context-v1, ещё без numeric features/training; прогнозы недоступны. Проверки: `pnpm test:dataset-builder`. [Config, gates и ограничения](docs/S3_00_DATASET_BUILDER.md), [свежий live audit](docs/S3_00_SOURCE_AUDIT.md).

### S3-01 — аудит корпуса и временных выборок (частично)

`pnpm identity:provision preview --out reports/identity-preview.json` готовит проверяемый план канонических связей; `apply --plan ... --sha256 ... --out ...` атомарно применяет его с повторной проверкой конфликтов. Для десяти аккаунтов первой выбранной карты TI2023 уже созданы10 канонических игроков и dated claims; повтор дал0 вставок. Состав, известный до карты, и training readiness ещё не подтверждены. [Применение, воспроизведение и ограничения](docs/S3_01_IDENTITY_PROVISION.md).

`pnpm cohort:identity --out reports/new-ti12-identity-evidence.json` проверяет архивный реестр OpenDota и воспроизводит проверку frozen ledger **до provision**, где было0 canonical links. Архив2023-04-11 содержит10/10 account ID выбранной карты; текущее применение связей описано выше. Exit0 означает полное source coverage; map lineup и training readiness ещё не подтверждены. [Источники](docs/S3_01_IDENTITY_EVIDENCE.md).

`pnpm cohort:lineup --out reports/new-ti12-lineup-evidence.json` сопоставляет архивную регистрацию Valve, текущих участников выбранной карты и frozen canonical ledger revision20. Архив2023-10-07 содержит обе нужные пятёрки;10/10 numeric IDs и native slots совпали с участниками карты. Регистрация не доказывает объявление состава для этой карты до старта: strict lineup/training остаются unavailable. Команда не пишет в БД; exit0 означает завершённый capture. [Результат, блокер и следующий шаг](docs/S3_01_LINEUP_EVIDENCE.md).

`pnpm schedule:audit --out reports/new-upcoming.json [--tournament ID]` проверяет актуальное расписание PandaScore и ожидаемые составы одного турнира. Нужен локальный `PANDASCORE_API_TOKEN` в `.env`, только server-side. Живой capture2026-11-01:20 предстоящих встреч; Team Yandex—Team Spirit/турнир22231,8 команд и5+5 ожидаемых игроков. Provider IDs пока не связаны с историей OpenDota; экран реализован в S1-10. Без ключа команда пишет blocked/0 HTTP, существующий отчёт не перезаписывает. [Настройка, факты и ограничения](docs/S1_09_UPCOMING_SOURCE.md).

`pnpm cohort:evidence --out reports/new-ti12-evidence.json` проверяет архивные метаданные Valve до TI2023. Найден также датированный регистрационный ответ с пятью никами одной команды; account links и фактические составы карт не подтверждены. [Историческое evidence и границы](docs/S3_01_HISTORICAL_EVIDENCE.md).

`pnpm cohort:accounts --out reports/new-ti12-account-evidence.json` проверяет архивные team-info responses и совпадения по Steam32 ID. Архивы2022 года подтверждают source associations для6/10 account ID первой карты TI2023; canonical links и actual lineup known-at ещё не подтверждены, training examples0. [Account evidence, команды и ограничения](docs/S3_01_ACCOUNT_EVIDENCE.md).

`pnpm cohort:profiles --out reports/new-ti12-profile-evidence.json` проверяет найденные Steam-профили по embedded numeric ID. Сохранённые доказательства дают observations9/10:6 organization associations и3 self-published profiles. Последний live capture дал8/10 из-за HTTP302 одного архива; offline replay отдельно проверил все сохранённые тела. Это не verified canonical identities или состав карты; exit3 означает неполный результат. [Источники и replay](docs/S3_01_PROFILE_EVIDENCE.md).

`pnpm corpus:audit docs/evidence/s3-01-corpus-config.json reports/new-corpus-analysis.json` воспроизводит offline diagnostic сохранённых live captures: SHA, дедупликация карт, конфликты, покрытие и явные временные окна. Итог —1287 уникальных ID и87 подробно проверенных карт; пригодность для исторического обучения не установлена. Output должен быть новым файлом.

`pnpm dataset:audit stored <dataset-uuid>` или `pnpm dataset:audit file reports/export.json <expected-sha256>` независимо проверяет неизменяемый dataset, четыре окна и целые provider-серии, включая несколько canonical aliases. Проверки: `pnpm test:dataset-splits`, `pnpm test:fixtures`. Политика подготовки теперь v2; legacy snapshots не переписываются. Структурный PASS не разрешает training/deployment. S3-01 остаётся открытой до реального as-of evidence cohort. [Контракт и replay](docs/S3_01_SPLIT_AUDIT.md), [новый live audit](docs/S3_01_SOURCE_AUDIT.md).

## Предстоящие матчи — S1-10

После `pnpm db:migrate` (019) и запуска `pnpm dev` войдите владельцем и откройте «Предстоящие матчи» (`/upcoming`). Ключ `PANDASCORE_API_TOKEN` остаётся только в серверном `.env`. Обновите расписание, выберите встречу и загрузите заявки. Время матча показано в МСК; время получения источника — отдельно. Server cache5мин и общая PostgreSQL quota защищают источник.

В раскрывающемся блоке найдите две организации и10 разных игроков по имени или ID, явно выберите записи из локального справочника, подтвердите роли и создайте обычный manual scenario. ID PandaScore не подставляются как canonical IDs. Если источник недоступен, последнее расписание сохраняется с предупреждением. Проверки: `pnpm test:upcoming`, `pnpm test:e2e`. [Поведение, API и ограничения](docs/S1_10_UPCOMING_UI.md).

S1-11: поиск доступен прямо в каждом поле состава. Enter запускает поиск, результат выбирается кнопкой; текст без выбора не считается игроком. Тёзки различаются по ID, повторный игрок недоступен, правка выбора снимает подтверждение состава. Пустая выдача требует уточнения запроса или пополнения локального каталога. [Поведение и проверки](docs/S1_11_CATALOG_PICKER.md).

S1-12: рабочий каталог пополнен текущими записями Spirit/Yandex —11 игроков,1 новая организация, существующая Spirit переиспользована. Все записи находятся по локальному имени/ID; точные имена и ID приведены в [таблице S1-12](docs/S1_12_CURRENT_CATALOGUE.md). OpenDota сообщает5+6 кандидатов: пятёрку и роли выбирает владелец. `pnpm catalogue:current` предоставляет ограниченный capture → reviewed preview → apply с SHA, conflict/stale guards и replay0; синхронизация не включается при каждом поиске. [Контракт, команды и evidence](docs/S1_12_CURRENT_CATALOGUE.md).

S1-13: загружены10 завершённых pro-карт PARI UNIVERSE за29–31 октября2026 (9 новых +1 обновлённая). На страницах организаций и игроков доступны описательные отчёты с N/source/filters: по5 карт у Spirit/Yandex и десяти основных игроков, DM0/null. `pnpm provider:audit --teams ... --capture ...` и `pnpm history:current preview/apply ...` позволяют обновлять ограниченную выборку через сохранённый source capture и проверенный импорт; повтор сохраняет число карт и ревизии. [Команды, покрытие и ограничения](docs/S1_13_CURRENT_HISTORY.md).

S1-14: на странице организации выберите **«Загрузить последние pro-карты»**. Запуск идёт через durable очередь; состояние, объём, время источника и частичный результат видны на странице, статистика перечитывается после завершения. Повторные клики используют прежний run; cooldown5мин после завершения. API/worker защищают source quota и idempotency. Проверки: `pnpm test:history-refresh`, `pnpm test:e2e`. [Запуск worker, API и ограничения](docs/S1_14_HISTORY_REFRESH.md).

S1-15: в ручной форме `/upcoming` явно выберите организации из локального справочника. Под выбором появятся N, наблюдаемый win rate, даты, источник и покрытие последних 20 локальных pro-карт; здесь же можно обновить историю и открыть полные отчёты/сравнение организаций. Игроки и роли выбираются отдельно. [Поведение и ограничения](docs/S1_15_UPCOMING_SUMMARY.md).

S1-16/17: выберите десять разных игроков, подтвердите роли и нажмите **«Сравнить выбранные пятёрки»**. Показаны отдельно история организаций, точных пятёрок,10 пар и игроков с N/датами/coverage. По умолчанию последние90 дней; доступны даты UTC и ID патча/лиги. Изменение фильтров сохраняет состав/подтверждение, скрывает прежний результат до нового запуска. Enter в фильтре выполняет только сравнение; сценарий не сохраняется. [Сравнение](docs/S1_16_UPCOMING_LINEUPS.md), [фильтры и QA](docs/S1_17_UPCOMING_FILTERS.md).

Период сравнения не переносится в сохраняемый сценарий: его срез фиксируется при сохранении, начало периода отчёта выбирается отдельно. Сохранённая версия отчёта не меняется после обновления истории; новый расчёт создаёт новую версию. [Сквозная проверка S1-18](docs/S1_18_UPCOMING_WORKFLOW_QA.md).

После выбора строки расписания экран и фокус клавиатуры переходят к карточке ожидаемых составов. Это помогает на телефоне и при длинном списке встреч. [Приёмка реальных данных и S1-20](docs/S1_20_OWNER_ACCEPTANCE.md).

После успешного обновления расписания или заявки API автоматически сохраняет неизменяемый снимок источника и серверное время в `upcoming_source_observations` (миграция021). Для этого не нужен отдельный запуск Codex. Снимок подтверждает только доступность объявления на момент записи; связь с фактической картой, игроками и драфтом проверяется отдельно. На16 текущих pro-картах strict dataset preview дал0 пригодных для обучения примеров, поэтому прогнозы пока недоступны. [Evidence и ограничения](docs/S1_08_PROSPECTIVE_SOURCE_EVIDENCE.md).
