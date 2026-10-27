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
