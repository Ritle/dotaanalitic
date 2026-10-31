# S0-04 — Point-in-time schema / temporal semantics

Внутренний контракт чтения контекста карты: `MatchContextRepository.append/readAsOf` в `@dota/db`; runtime Zod-схемы в `@dota/contracts`; чистая `resolveContextAsOf` без сети и системных часов. Это основание для следующих задач, не готовый feature builder или model eligibility gate. Нового HTTP endpoint нет.

## Времена и доказательства

- `matches.started_at` — фактический старт одной карты, эквивалент смысла `played_at`; второй дублирующий столбец не добавляется.
- `event_at` — событие объявления/наблюдения факта, nullable. Для объявления будущего матча это дата объявления, а не будущий старт.
- `known_at` — подтверждённая доступность факта, nullable; не выводится из старта, fetch или итогового состава.
- `fetched_at` — время получения источника. Поздний архив допустим только с независимым доказательством исторического `known_at`.
- Все typed timestamps — UTC ISO с тремя знаками миллисекунд. Нельзя округлять микросекундное позднее знание в cutoff.

Миграция `009_temporal_context.sql` расширяет существующие immutable `match_field_observations`: event/availability/stage и fingerprint типизированного наблюдения. Старые строки сохраняют NULL event/known, availability `unknown`, stage `post_match`; массовой переинтерпретации или backfill нет. Сырые provider-поля отделены от `context.*` и не читаются как доказанный контекст.

`append` валидирует строго допустимые поля и значения, канонизирует native slots и ключи JSON, сохраняет все три времени/source/evidence/review/adapter. Один и тот же набор доказательств записывается один раз, в том числе при конкурентном retry. Новое наблюдение и увеличение `matches.data_revision` атомарны; повтор не меняет revision. Исправление — новая строка, UPDATE/DELETE блокируются существующим триггером. Изменение fetchedAt означает отдельное наблюдение.

## Политика `strict-asof-v1`

`readAsOf({matchId, cutoffAt, stage})` одной SQL-командой получает start bound, revision и наблюдения. Отсутствующая карта, canonical ingest conflict или cutoff после старта дают `unavailable` с кодом причины. В cutoff разрешено равенство старту для offline boundary; это само по себе не доказательство prospective прогноза.

Поле доступно только при `availability=verified_asof`, `reviewState=accepted`, непустом evidence, `known_at <= cutoff`, event не позже cutoff и подходящей стадии. `user_asserted_asof`, `retrospective_fact`, `unknown` не переводятся в strict cohort. Их хранение не включает conditional/live policies автоматически; это отдельные S0-09/S2/S3 gates.

Разрешены typed facts: UUID серии, номер карты, счёт серии перед картой, соответствие организаций сторонам, first-pick side, версия порядка драфта, native lineup slots, роли с basis/confidence, герои. IDs сохраняются строками; для слотов принимаются только 0–4 / 128–132. Дубли слотов, игроков и героев отвергаются; неизвестные IDs остаются NULL. Роль и её confidence хранятся отдельно от lineup и не выводятся из индекса массива. Низкая уверенность не повышается до confirmed; дальнейший role gate — S0-05.

Герои/first-pick/order запрещены в pre-match даже при раннем timestamp. Счёт серии сохраняется, но не возвращается как MVP feature (`BETWEEN_MAPS_UNSUPPORTED`); отдельная between-map модель остаётся P2. Outcome/duration/GPM/KDA вообще отсутствуют в whitelist контекста. `sideToScenarioSlot` требует явный `radiantSlot`, не подразумевает A=Radiant и не выводит first pick из стороны. Существующие поля `scenarios.radiant_slot`, `matches.map_number`, scores/first pick/draft version сохранены.

Противоречащие доступные доказательства дают `CONFLICT`, включая противоречие известного значения и NULL; последняя загруженная запись не побеждает автоматически. Поздно известное исправление не меняет исторические resolved fields. Решение содержит policy/revision, причины отсутствия и IDs использованного immutable evidence. Для исправлений конфликтов понадобится отдельный проверяемый review workflow, не скрытый last-write-wins.

`isPriorCompletedMap` проверяет только временное окно: `started_at < cutoff`, завершение после старта и не позже cutoff. Это НЕ заменяет `is_pro IS TRUE`, availability исхода, identity/patch/series и training gates. Полный исторический reader/feature builder — последующие задачи.

## Проверки и ограничения

2026-10-31 PASS: frozen install, typecheck, build; 82 unit, 9 temporal PG, 4 baseline PG, 16 ingestion/queue PG, 11 auth PG/CLI, 10 Node fixture tests. 009 APPLIED, повтор 9 SKIP; исторические checksums сохранены, doc links/git diff проверены. Compiled Node reader проверен на рабочей импортированной карте: все непроверенные historical facts недоступны. E2E/Python/Docker/remote CI в этой задаче не запускались. До исправления SQL precision regression воспроизведён failing test; после исправления все 9 temporal PG tests PASS.

Команда специализированных PostgreSQL-тестов: `pnpm test:temporal`. Используется отдельная случайная тестовая БД с реальными миграциями; synthetic facts не записываются в рабочую БД. CI включает эту команду.

Проверяются boundary cutoff, late import/correction, no draft before stage, null/unknown, конфликт и порядок observations, explicit A/B mapping, BIGINT, роль/slot, completion window, concurrent retry/revision, immutable evidence и SQL provenance constraints.

Исторические migration 001–008 не изменяются. После применения 009 следующий SQL — 010+. No new provider calls, no synthetic training, no probabilities. Доказательств реальной pre-start coverage этот код не создаёт. Полнота 10 героев, подтверждённые canonical identities, исторические draft rules, staged corpus и predictive quality gate остаются обязательными будущими проверками.

Следующая задача: **S0-05 — Identity & lineup integrity**; рекомендуемая модель **GPT-6 Astra · High** по routing проекта.
