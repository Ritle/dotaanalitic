# План разработки Codex — приоритеты и зависимости (v5 engineering decision update)

**Статус:** v4, план, а не отчёт о реализации. Неотмеченные пункты не готовы. За одно задание Codex выполнять один небольшой вертикальный срез, обновлять тесты и `docs/PROGRESS.md`.

## Рекомендации по модели Codex (v6)

Перед каждой задачей Codex оценивает сложность по [CODEX_MODEL_ROUTING.md](CODEX_MODEL_ROUTING.md) и, если это поможет, **однократно рекомендует** модель и effort. Это ручной выбор пользователя, не автоматическое действие и не дополнительный gate выполнения.

| Этап | Подход по умолчанию | Когда усилить модель |
|---|---|---|
| S0 | Sol · Medium/High | Astra · High для S0-04..07, сложной миграции и конфликтов провайдеров |
| S1 | Sol · High | Astra · High для S1-03/05/07 и проблем as-of/патчей |
| S2 | Sol · Medium/High | Astra · High при ошибках драфта, сыгранности или инвариантов расчёта |
| S3 | Astra · Extra High для S3-00..06 | Sol · High для ограниченных UI/отчётных задач, когда критическая модель уже проверена |
| S4 | Sol · High | Astra · High для угроз безопасности, скрытых инвариантов, серьёзного рефакторинга |
| S5 | Sol · Medium/High | Astra · High/Extra High для S5-06 (retrain/champion-challenger) |

**P0 не тождественно Astra**: рекомендации зависят от сложности и последствий ошибки. После сложного этапа Codex кратко подсказывает, когда можно вернуться к Sol.

## Как читать приоритеты

- **P0 — архитектурно обязательное для корректного MVP**: не откладывать фундамент даже если пользовательский экран делается позже. До готовности P0 прогнозы остаются `unavailable`.
- **P1 — полезная функциональность следующей итерации**: предусматриваем расширение в схеме/контрактах сейчас, но не тратим время на полный UI/ML до рабочих P0.
- **P2 — развитие после MVP**: не реализуем преждевременно, только оставляем совместимые границы.
- ID вида `S0-01` обозначает *этап и порядковый номер*, **не приоритет**. Задачи выполняются в порядке зависимостей, не по значению числа.
- **Migration 004** содержит nullable поля и таблицы для фундаментальных гарантий. Она является схемой, а не реализованным сбором/валидацией фактов. Не пытаться заполнять неизвестные сведения догадками.

## Инженерные документы, обязательные перед реализацией

Перед задачами S0 Codex читает [TECHNICAL_ARCHITECTURE_AND_STACK](TECHNICAL_ARCHITECTURE_AND_STACK.md), [DEPENDENCY_MATRIX](DEPENDENCY_MATRIX.md), [ENGINEERING_PATTERNS](ENGINEERING_PATTERNS.md), [DATA_PIPELINE_DESIGN](DATA_PIPELINE_DESIGN.md), [ML_ENGINEERING_DECISIONS](ML_ENGINEERING_DECISIONS.md), [DEPLOYMENT_AND_TESTING](DEPLOYMENT_AND_TESTING.md). [TECH_DECISION_REGISTER](TECH_DECISION_REGISTER.md) фиксирует ADR-025..037. **Новые документы — дизайн, не завершённые фичи**. Уже применённые `001..005` forward-only SQL не переписывать.

| Этап | Технические границы/выборы, обязательные до кодирования | Приёмочный gate |
|---|---|---|
| S0-00 | Проверить Node/pnpm/Vite/Vitest/Fastify/Zod peer versions, lockfile, fresh DB migrations, `pg` | Чистый install/build/test, `pnpm-lock.yaml`, миграции 001..006 на реальной PostgreSQL |
| S0-01 | `ProviderAdapter`, runtime Zod, bounded fetch concurrency, timeout/Retry-After, evidence/known_at | Fixture coverage, отсутствие догадок и инъекции endpoint URL |
| S0-02 | `pg-boss` own schema, at-least-once idempotency, Kysely typed repositories, SQL transaction boundaries | Duplicate/retry/crash imported map count 1, no double jobs/labels |
| S0-03 | Argon2id + DB opaque session + cookie/CSRF/rate limit | 401/403/expiration/login throttling tests |
| S0-04/05/06 | Three clocks, known-before-stage lineup, normalized canonical identity, draft/patch context | Historical backfill doesn't introduce hindsight features |
| S1 | Vue Query server state vs Pinia local editing, patch-aware aggregates, SQL EXPLAIN | Correct cache invalidation, n_raw/n_eff, cohort coverage |
| S2 | Scenario revision optimistic locking, immutable report; pick/ban unique rules | 409 stale revisions, no duplicate heroes, 10 verified players |
| S3 | Offline Python sklearn trained baseline; TS JSON inference, model artifact SHA, stage-aware chronological evaluation | Python↔TS parity golden vectors; no invalid win %; reproducible model lineage |
| S4 | CI integration + Playwright + backup restore + one-VPS operation | Full tests, restore drill, no secrets/DB published |
| S5 | P1 batch retrain/monitor, opt-in promotion; P2 extensions later | Champion unchanged if challenger fails, audit and rollback |

## S0 — техническая основа и достоверность источников

- [ ] **S0-00 [P0] Bootstrap** (предыдущий `P0-00`): установить зависимости, lockfile, применить миграции **001→002→003→004→005→006**, поднять PostgreSQL/API/Web, `/health`, CI, `typecheck`, тесты и сборку. Сверить совместимость Zod 4 + Fastify plugin, pin resolved Node/pnpm deps; не устанавливать пакеты следующих этапов до необходимости. **DoD:** воспроизводимый запуск на чистой БД; checksum миграций не меняется.
- [ ] **S0-01 [P0] Provider spike** (предыдущий `P0-01`): проверить реальные OpenDota `/proMatches`, `/matches/:id`, `/teams/:id/players`, игрока и состав; 3–5 обезличенных fixtures; проверить nullable/неполные поля, неизвестные side/picks/bans/first pick, выдачу серии, версии адаптеров и ограничения. **DoD:** строгая Zod-валидация и отчёт о покрытии, никакого приписывания данных.
- [ ] **S0-02 [P0] Идемпотентный импорт и происхождение** (предыдущий `P0-02`): нормализовать одну карту, 10 слотов, is_pro только по доказательству, историю drafts; сохранять `match_source_snapshots`, `match_field_observations`, версии адаптеров, причины missingness и конфликты провайдеров; Retry-After, durable `pg-boss` worker (без Redis), idempotent DB transactions, типизированные `pg`/Kysely repositories (при внедрении), очередь не обещает exactly-once, и временные ошибки. **DoD:** повторный импорт не меняет число карт; спорные факты не перезаписываются молча.
- [ ] **S0-03 [P0] Личный доступ** (предыдущий `P0-03`): единственный владелец, Argon2id, opaque server-side DB session, Secure/HttpOnly cookie, CSRF, rate-limit, ограничение попыток и CLI установки. **DoD:** нет публичной регистрации, приватные API возвращают 401 без сессии.
- [ ] **S0-04 [P0] Point-in-time schema / temporal semantics**: на уровне репозитория отличить `played_at/started_at`, `known_at`, `fetched_at`; карта ≠ серия; сохранить `map_number`, результат серии *перед* картой, `radiant_slot`, first pick/порядок драфта (только если известны), слот пятёрки и доказательство роли. **DoD:** backfill из будущего никогда не становится исторически известным до cutoff.
- [ ] **S0-05 [P0] Identity & lineup integrity**: player canonical ID + подтверждённые связанные аккаунты, aliases, cross-org история, состав на дату и пятёрка с конкретными ролями, source/known_at; unverified alias/account не склеивают игроков. **DoD:** трансфер не обнуляет личную статистику, полная смена состава не наследует сыгранность тега, роль с низкой уверенностью маркируется unknown.
- [ ] **S0-06 [P0] Матчевый контекст и валидность героев**: схема и нормализация стороны Radiant/Dire, карты в серии, первых пиков, правила драфта для патча, турнирного ограничения доступности героев. Отсутствующее правило доступности ≠ ban/allow; pre-draft не использует пост-драфтовые сведения. **DoD:** неизвестная сторона/порядок/турнирные ограничения остаются `null`, а не угадываются.

- [ ] **S0-07 [P0] Архитектура verified outcomes и frozen datasets**: подключить migration 005 и контракт `docs/CONTINUOUS_LEARNING_PIPELINE.md`, верификацию меток только через карту pro, раздельное хранение labels vs features, freezing, единый map ID per dataset/stage. **DoD:** SQL ограничения на pro/winner/team orientation, архивированный frozen dataset нельзя править, прогноз или пользовательский guess не попадает в обучающую выборку. Реальный DatasetBuilder реализуется в S3-00.

## S1 — базовая статистика и оценка силы

- [ ] **S1-01 [P0] Справочники и обзоры** (было `P1-01`): поиск teams/players/heroes; история организация vs current five vs player; freshness.
- [ ] **S1-02 [P0] Качественные pro-map выборки** (было `P1-02`): патч/дата/оппонент/роль/сторона, raw `n`, покрытие, nullable показатели, отдельно неизвестные pro и неточные roster/series.
- [ ] **S1-03 [P0] Состав и замены** (было `P1-03`): exact-five, 10 исторических пар через любые организации, роль 1–5, churn и свежесть; сравнение ожидаемой и выбранной пятёрки без фиксированного штрафа. **DoD:** замена игрока изменяет нужные признаки, но не переносит старые победы организации в новую пятёрку.
- [ ] **S1-04 [P0] Игрок × герой × позиция** (было `P1-04`): карты/победы/KDA/GPM/XPM с coverage и подтверждением позиции; перемена ролей не игнорируется.
- [ ] **S1-05 [P0] Baseline Elo/strength of schedule**: обновлять рейтинг *хронологически*, учитывать силу оппонента до каждой карты, сравнить с необработанным win rate; стартовая сила новой пятёрки строится осторожно из player/roster факторов, а не наследуется тегом. **DoD:** два одинаковых WR против разных по силе соперников не получают принудительно равные strength features.
- [ ] **S1-06 [P0] Размер выборки и надёжность**: глобальные/pro-patch и player-hero показатели со сглаживанием и корректными prior, raw `n`, Kish `n_eff` для взвешивания, missingness, cold-start; маленькая выборка не равнозначна большой. **DoD:** `n=0 -> rate=null`, shrinkage тестируется на synthetic fixtures.
- [ ] **S1-07 [P0] Проверенная мета патча**: геройские изменения, hero availability, вес истории по patch/time/rework для draft vs отдельный decay для strength; invalidation при корректировке patch registry; temporal evaluation.
- [ ] **S1-08 [P0] Team compare / H2H** (было `P1-05`): учёт реальных lineup identity, ранга оппонента, корректных team A/B vs Radiant/Dire и даты анализа. **DoD:** сравнение команд не использует статистику 5-летнего состава как текущего.

## S2 — Draft Lab и аналитика карты

- [ ] **S2-01 [P0] Сценарии** (было `P2-01`): manual confirmed 5+5, side optional, карта одной серии, known/unknown context, snapshot, revision/optimistic lock, expected lineup.
- [ ] **S2-02 [P0] Draft Lab** (было `P2-02`): 0–10 назначенных уникальных героев, игрок-роль-герой, optional bans, constraints доступности героев с подтверждённым источником, описание unknown.
- [ ] **S2-03 [P0] Союзная синергия и контрматчапы** (было `P2-03`): каждая карта один раз на союзную unordered пару, directed hero A vs B, выборка только до cutoff; patch-sensitive weights и shrinkage.
- [ ] **S2-04 [P0] Репорт и data coverage** (было `P2-04`): raw/adjusted metrics раздельно, позиции, патч, unknown side, временной диапазон, качество подтверждения состава, история версий отчёта.
- [ ] **S2-05 [P1] Полный draft order**: историческая последовательность picks/bans, first-pick side, draft-order-version и phase-aware признаки; модель без этих сведений не выдаёт их за известные. **DoD:** порядок соответствует правилу исторического патча.
- [ ] **S2-06 [P2] Структурный стиль драфта**: контроль, инициация, tower pressure, scaling, tempo, защита; сначала явная экспертная версия признаков, затем проверка их добавочной ценности на временном holdout, без необоснованных оценок.

## S3 — две прогнозные модели и честная проверка

- [ ] **S3-00 [P0] OutcomeVerifier + DatasetBuilder (offline)**: авторитетные исходы completed pro-карт → 1 map / dataset/stage; frozen point-in-time input snapshots с отдельной меткой и versioned manifest, series-aware chronological splits, проверка match/patch/lineup availability, CLI подготовки датасета. **DoD:** 10 прогнозов карты не увеличивают число обучающих примеров; late import/исправление label не меняет прошлые frozen dataset; неизвестные match/team sides excluded.
- [ ] **S3-01 [P0] Dataset/series-aware temporal splits** (было `P3-01`): использовать frozen DatasetBuilder из S3-00, широкий pro-корпус; хронологические train/calibration/test без пересечения целых известных серий, versioned fingerprints. `cutoff_at` — время доступности признака, а не дата последующего API fetch.
- [ ] **S3-02 [P0] ОДИН point-in-time feature builder** (было `P3-02`): train == inference feature specification; один TS feature builder + frozen экспорт для offline Python, `known_at ≤ cutoff`, `started_at < cutoff`, confirmed identities/role coverage; side known only when legitimate; исключить результаты будущих карт, следующую карту серии и `picks_bans` из pre-match. Смена состава, роль, opponent strength, patch context — отдельные группы признаков.
- [ ] **S3-03 [P0] Pre-map Elo + calibrated logistic model** (было `P3-03`): Python sklearn baseline: preprocessing + LogisticRegression + independent temporal calibration, export versioned canonical JSON coefficients; Node TS inference parity golden vectors; сохранять model_training_runs/config/seed, artifact hash и candidate inactive; прогноз одной карты **до драфта**; абляции `team only`→`+player`→`+cohesion`→`+opponent strength/role`; хранить Brier, Log Loss, калибровку и strata.
- [ ] **S3-04 [P0] Post-draft model** (было `P3-04`): десять разных героев + role assignment, patch-aware hero/pair/counter, first-pick/side **если известны**; out-of-fold pre-score, одна тестовая выборка для проверки выигрыша относительно pre-match. Не считать предиктивный прирост доказанным без теста.
- [ ] **S3-05 [P0] Quality gate, candidate promotion и честный fallback** (было `P3-05`): versioned model_evaluation_runs; atomic/approved ModelRegistry promotion + append-only audit/rollback; только прошедшая временную проверку версия выдаёт числовую вероятность; cold patch/small `n_eff`/lineup missing/insufficient context → `unavailable` или предупреждение в рамках валидированной policy; никакого выдуманного 50/50.
- [ ] **S3-06 [P0] Репродуцируемые снапшоты**: frozen `input/features`, `data_revision`, `feature_schema_version`, патч, выбранные игроки/роли, модель/версия, признаки её качества; DB trigger запрещает UPDATE терминального прогноза; невозможно обновлением данных изменить старый прогноз.
- [ ] **S3-07 [P1] Model Performance / verified actual result linking**: `prediction_outcomes` привязывает прогноз к доказанной завершённой pro-карте после факта, не мутируя `prediction_runs`; не смешивать hypothetical/retrospective и genuinely prospective live прогнозы, график/таблица Brier, Log Loss, calibration, число игр, разрез по патчу, смене состава и сроку после релиза патча.
- [ ] **S3-08 [P1] Что изменил драфт**: сравнивать pre/post только для одинакового `scenario_revision`, cutoff, состава и known context; показывать delta в п.п. и признаки, но не утверждать причинность.
- [ ] **S3-09 [P2] Победа в серии / между картами**: отдельные target и модели BO1/BO2/BO3/BO5 с результатом серии до прогнозируемой карты. До реализации карты серии/счёт хранятся как проверяемый контекст, не используются для выдуманного series win %.

## S4 — release hardening / личное использование

- [ ] **S4-01 [P0] Безопасность и ретраи** (было `P4-01`): CSRF/auth/secret, upstream 429/retries, провайдерские конфликты.
- [ ] **S4-02 [P0] E2E и историческая регрессия** (было `P4-02`): тесты ролей/патчей/составов/серий/сторон/доступности героев, ас-оф и data quality; backup/restore.
- [ ] **S4-03 [P0] Деплой single-owner** (было `P4-03`): Docker Compose, мониторинг, бэкапы, закрытый доступ.

## S5 — P1/P2 после рабочего MVP (реализовывать по запросу)

- [ ] **S5-01 [P1] What-if Analysis**: копия сценария с `parent_scenario_id`, изменение одной переменной (stand-in, Radiant/Dire, герои), сравнение двух *валидированных* прогнозов и их состояния/покрытия. Сохранить immutable исходный сценарий/снимок.
- [ ] **S5-02 [P1] Турнирный контекст**: verified tier, stage, LAN/online, tournament/region, role stability per tier, оценка добавочного качества по временным срезам, без произвольного коэффициента «TI ×2».
- [ ] **S5-03 [P1] Контроль корректности и полноты**: UI для review связей аккаунтов, провайдерских конфликтов, provenance, ручной проверки roster/roles; настройки временного окна и источников.
- [ ] **S5-04 [P2] Мета-стили команд и структурные draft features**: карта темпа, контроль, scaling и другое, через версионированные признаки и backtest.
- [ ] **S5-05 [P2] Модели серии и between-maps**: форматы BO, текущий счёт, map-specific priors, честная проверка отдельно от pre-map.

- [ ] **S5-06 [P1] Batch retraining + champion/challenger**: durable jobs для планового/patch-triggered обновления frozen dataset и кандидата, versioned config, independent temporal+prospective evaluation и drift, сравнение с действующей моделью. По умолчанию ручная активация; автоматическую разрешить **только opt-in** после gate, CAS transaction, stage/sha checks, promotion audit/rollback. **DoD:** failed retrain не меняет активную модель; несколько карт/прогнозов не инициируют множественные обучения; model history воспроизводима.

## Архитектурные gate (проверить ДО любой публикации прогнозов)

1. `matches`, `match_players`, `series` нормализованы; organization ID никогда не подменяет игрока/пятёрку.
2. Feature builder различает **событие**, **когда о нём стало известно**, **когда оно попало в нашу БД**; задним числом загруженная статистика не может быть знанием для ретро-прогноза.
3. Historical targets — **карты**, а не серии; серии целиком лежат в одном validation split.
4. Source+version+evidence+coverage, player identity+role provenance, patch hero changes & availability сохраняются; конфликт отображается вместо неверной «истины».
5. Pre-match не использует героев, draft order и результаты текущей карты; post-draft использует 10 heroes и допущенный контекст, валидирует доступность.
6. Missing/unknown сохраняются как `null`, малая выборка сглаживается, `n_eff`/quality сравниваются отдельно от p(win).
7. Хранится неизменяемый прогноз, позже — отдельная привязка actual outcome; воспроизводимы набор данных и версия модели.
8. Backtest отчёт: temporal+series-aware, baseline vs current Brier/LogLoss/calibration, ablations и срезы (новый патч, замена, сторона, слабая выборка).

## Дисциплина выполнения

Не запускать массовый scraper и не обучать модель во время HTTP-запроса. Не отмечать `[x]` без выполненных автоматических тестов и проверки связанных критериев. Если PostgreSQL/Docker/API недоступны — документировать `blocked`. Всегда фиксировать изменения и точную следующую задачу в `docs/PROGRESS.md`.

## Дополнительные gate v4 — continuous learning

- **P0** `matches` — источник verified map labels; сохранённые `prediction_runs`/ручные «кто победит» не используются как labels и не увеличивают train sample. One match → one row per frozen dataset/version/stage.
- **P0** Frozen feature snapshots вычислены строго до старта карты, target помечен временем *после* матча; исправление outcome/source = новый dataset version, не UPDATE frozen artifacts.
- **P0** У кандидата есть training run/config/seed, frozen dataset fingerprint, code revision и SHA-256 артефакта. Evaluator не выбирает модель по repeatedly reused test set; champion остаётся активным при непрохождении gate, promotion/rollback логируются.
- **P1** Re-training triggers batch/schedule, never synchronous per match/request. Verification of new outcomes and prospective-only performance separated from historical offline backtest. **P1 automatic promotion OFF by default.**


## v7 — инженерные задачи DX/QA (в порядке выполнения; P0 прежде P1)

- [ ] **DX-00 [P0] Проверка и фиксация окружения**: реальный `pnpm-lock.yaml` через сеть, CI с frozen install, `scripts/preflight.mjs`, `scripts/verify-migrations.mjs`; `pnpm install/typecheck/build` PASS. **Зависит от:** S0-00.
- [ ] **QA-01 [P0] Golden test fixtures**: синтетические complete/incomplete pro maps, roster stand-in / cross-org / cutoff / magic zero, TypeScript golden metrics tests. Уже подготовлено в v7; закрыть после полного `pnpm test` и проверки сценариев импорта S0-02.
- [ ] **QA-02 [P0] PostgreSQL integration gate**: PG16 test database, 001–006 twice, проверки frozen dataset/ledger и raw draft/quality, никаких skipped tests. Подготовлены тесты и CI, выполнить на Docker/GitHub Actions.
- [ ] **ML-00 [P0] Reproducible ML bootstrap**: sklearn, audited cutoff/series chronology, frozen artifact SHA, TS parity, candidate never activated. Синтетический прогон проверен; реальная модель остаётся S3-00..06.
- [ ] **DX-01 [P0] Codex handoff**: `docs/CODEX_WORKFLOW.md`, `PROJECT_STATE.md`, PROGRESS appends, next task and exact PASS/BLOCKED. Проверять каждый PR.
- [ ] **QA-03 [P1] Playwright E2E**: bootstrap smoke now; реальные login/team/draft/predict user flows добавить по мере реализации S0-03/S1/S2/S3.
- [ ] **OPS-01 [P1] VPS release validation**: Compose/Caddy/backup/restore, real Docker smoke, staging restore drill, security review after auth S0-03.
- [ ] **UI-01 [P1] Design System**: CSS tokens and contract in `docs/UI_DESIGN_SYSTEM.md`, реализовать компоненты только в S1/S2.
- [ ] **OBS-01 [P1] Metrics/observability**: логирование без секретов, source completeness and model reliability dashboards, alert thresholds after measurement.

Матрица фактически выполненных/blocked проверок: [V7_ACCEPTANCE](V7_ACCEPTANCE.md). **Не отмечать выполненным** на основании лишь того, что тест и конфигурация добавлены в репозиторий.

## v8 — Prediction Data Feasibility Gate (перед реализацией S1/S3)

- [ ] **S0-08 [P0] Live API evidence audit**: прочитать `docs/PREDICTION_DATA_SPEC.md`, выполнить `node scripts/audit-prediction-sources.mjs --sample 20 --out reports/opendota-coverage.json` при наличии сети, затем стратифицированную проверку старых патчей. Задокументировать реальные доли `identity_10`, `heroes_10_unique`, `patch`, `picks_10`, `series`, `roles_hint_10` и 429/5xx; сохранить дату выборки. **DoD:** ни одно поле не считается надёжно доступным без эмпирического подтверждения; если API недоступен, status BLOCKED и ни одной придуманной цифры.
- [ ] **S0-09 [P0] Point-in-time data readiness**: разделить `verified_asof` / `user_asserted_asof` / `retrospective_fact` / `unknown` для составов, ролей, стороны, патчей и драфтов; оформить строгую и conditional-lineup выборки. **DoD:** постматчевый roster никогда молча не используется как заранее известный pre-match.
- [ ] **S1-08 [P0] Pro corpus backfill quality**: проверить широкую выборку нескольких турниров и патчей; ID и winner label dedupe, source provenance, отчёты покрытия по patch/date, без смешения пабов, подготовить feature-readiness matrix для S3-00.

`S0-08/09` — архитектурные prerequisites для валидных прогнозов, но не блокируют создание базовой страницы интерфейса. `S1-08` обязателен перед обучением S3; внутренние номера не перенумеровывать.

## v9 — P0 raw-vs-final draft integrity (добавление к S0/S1/S2/S3, без перенумерации)

- [ ] **S0-10 [P0] Raw draft integrity & quality policy** — нормативно [DRAFT_DATA_INTEGRITY.md](DRAFT_DATA_INTEGRITY.md): применить миграцию `006_draft_data_quality.sql`, включить отдельную persist raw `picks_bans` (не менять 0/11/12 picks), финальные герои по десяти слотам, `match_quality_assessments` + версия policy + anomaly codes. `draft_order_valid` не становиться true без знания режима+патча. **DoD:** SQL migration/integration PASS; старые 001–005 checksum не менялись; draft outliers остаются в БД и не маскируются нормализацией.
- [ ] **S0-08 [P0], уточнение** — зафиксировать предоставленные владельцем 50 live observations как ограниченное evidence, не считать `draft_actions > 0` подтверждением draft timeline; повторить новую v9 schema report и историческую выборку.
- [ ] **S0-02 [P0], уточнение** — provider adapter raw-source import и canonical 10 player heroes происходят независимо; quality assessment не удаляет отдельные полезные facts, unknown team/series не восстанавливаются из текущей пятёрки.
- [ ] **S1-08 [P0], уточнение** — отчёты по статусам outcome/player/hero/team/series/timeline с разбивкой patch/league/period, без глобального исключения всех неполных карт.
- [ ] **S2-02/S3-04 [P0], уточнение** — hero-only Draft Lab и post-draft training НЕ требуют полного timeline, но требуют verified final heroes и честного cutoff; timeline-based features допускаются только после patch/mode validator (P1).
- [ ] **QA-04 [P0] Draft quality regression** — 0/11/12 picks, 10 финальных героев, extra IDs, mismatch стороны, team/series unknown, unknown draft order rules, повторный импорт и неизменяемость source observations. **DoD:** Node regression tests + реальный PostgreSQL тест; синтетические фикстуры не используются для ML training.

**Зависимости:** S0-10 реализуется при S0-02 после базы S0-00; QA-04 до S3; S0-06 предоставляет контекст patch/mode. Наличие подготовленных миграции, фикстур и тестов НЕ означает завершения задачи реализации нормализатора, DB миграций или обучения.
