# Первый промпт для Codex

```text
Ты ведущий full-stack разработчик этого репозитория Dota 2 Pro Analytics.

Прежде чем писать код, полностью прочитай AGENTS.md, README.md,
TECHNICAL_SPEC.md, docs/ARCHITECTURE.md, docs/DATA_MODEL.md,
docs/POINT_IN_TIME_AND_MATCH_CONTEXT.md, docs/IDENTITY_AND_DATA_QUALITY.md,
docs/MODEL_EVALUATION_AND_SCENARIOS.md, docs/CONTINUOUS_LEARNING_PIPELINE.md,
docs/PRIORITY_TRACEABILITY.md,
docs/DATA_SOURCES.md, docs/IMPLEMENTATION_PLAN.md,
docs/ACCEPTANCE_CRITERIA.md и docs/PROGRESS.md.

Выполни ТОЛЬКО задачу S0-00 из docs/IMPLEMENTATION_PLAN.md.
1) Проверь pnpm монорепозиторий, зависимости, tsconfig, Docker Compose и SQL.
2) Установи зависимости, сгенерируй и сохрани pnpm-lock.yaml.
3) Запусти PostgreSQL и примени последовательно все миграции 001→002→003→004→005→006.
4) Запусти web и API; проверь /health.
5) Запусти pnpm typecheck, pnpm test, pnpm build; исправь обнаруженные проблемы.
6) Добавь базовый CI для typecheck/test/build.
7) Обнови docs/PROGRESS.md: реально сделанные изменения, тесты, блокеры.

Не реализуй будущие этапы, не подменяй реальные данные mocks в API.
Если что-то нельзя проверить из-за отсутствия сети или Docker, честно зафиксируй это.
В конце дай список изменённых файлов, результаты проверок и готовность перейти к S0-01.
Дополнительное обязательное требование перед началом разработки: изучи `docs/PATCH_AWARE_ANALYTICS.md` и не реализуй импорт матчей или признаки прогнозной модели без корректного учёта патча, UTC-дат релиза и отдельной политики понижения влияния старых матчей.
```


Важно: прежде чем реализовывать importer/аналитику составов и ML, прочитай `docs/ROSTER_CONTINUITY.md` и `docs/PATCH_AWARE_ANALYTICS.md`. Флаг игрока в OpenDota не подтверждает, кто вышел на будущую карту. Реальные исторические пятёрки должны состоять из пяти известных Steam32 аккаунтов одной стороны. Сыгранность пар считай в том числе по их совместным играм за **прошлые** организации. Не добавляй произвольный штраф за stand-in. В миграциях применяй 001→002→003→004→005→006 строго последовательно.

**Новое v4:** изучить `docs/CONTINUOUS_LEARNING_PIPELINE.md` до разработки синка, обучения и model registry. В P0 добавить frozen training dataset с проверенными pro-исходами, но не реализовывать автоматическое переобучение в задаче S0-00. Модельные вероятности/пользовательские догадки не labels; миграция 005 добавлена и обязательна в bootstrap.


## Дополнение v5 — обязательно перед первым кодом

Ознакомься с `docs/TECHNICAL_ARCHITECTURE_AND_STACK.md`, `docs/DEPENDENCY_MATRIX.md`, `docs/ENGINEERING_PATTERNS.md`, `docs/DATA_PIPELINE_DESIGN.md`, `docs/ML_ENGINEERING_DECISIONS.md`, `docs/DEPLOYMENT_AND_TESTING.md` и ADR. Не устанавливай все библиотеки сразу; следующие технические решения привязаны к конкретным этапам и являются планом, а не существующим кодом. Для уже действующего проекта используй `CODEX_V5_TECH_UPDATE_PROMPT.md`.


## Дополнение v6 — подсказки по модели

Перед выполнением `S0-00` ознакомься с `docs/CODEX_MODEL_ROUTING.md`. В начале новой задачи (а также при возникновении качественно нового риска) кратко порекомендуй модель Codex и reasoning effort, если это имеет смысл. Не заявляй, что уже переключил модель, не навязывай Astra при простых изменениях и не блокируй работу ради рекомендации.

Перед реализацией import/драфта прочитай `docs/DRAFT_DATA_INTEGRITY.md` и тесты v9 (`tests/node/draft-quality.test.mjs`). Исходные события picks/bans нельзя silently correct.
