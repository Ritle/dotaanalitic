# S1-08 — сравнение организаций, выбранных пятёрок и H2H

Реализован описательный owner-only `/compare?teamA=&teamB=` и stateless `POST /api/v1/teams/compare`. Владелец явно выбрал S1-08 после архивного checkpoint: [решение](S1_07_NEXT_STEP_DECISION.md). S1-07 остаётся открытым P0 gate перед прогнозами; ready comparison не означает model eligibility. Модель и teamAWinProbability всегда null, predictionEligibility=not_assessed.

## Запрос и UX

JSON содержит teamAId/teamBId (разные BIGINT-safe decimal strings), manual lineupA/lineupB по5 role slots1–5 с nullable playerId/isStandin, optional fromAt/cutoffAt/patchId/leagueId. Известные player IDs должны существовать в каталоге и быть различны между обеими пятёрками. Пустые ID остаются unknown, текущие-members flags не используются. Stand-in не даёт фиксированного штрафа. Это локальное редактирование, не подтверждённое участие и не сохранённый сценарий; persistence/revisions остаются S2-01.

Default:90 дней до серверного snapshotAt. Future cutoff/from>=cutoff отвергаются. Время UTC, API precision3. Выбор/редактирование input скрывает старый отчёт до нового submit; Vue Query key содержит весь applied input. Из home и organization page доступны ссылки. Bookmark сохраняет только ID организаций, не пятёрки. Loading/error/retry/empty/unknown states, mobile360px, internal table scrolling.

POST выбран для двух manual lineups в body; GET compare, ранее описанный как planned пример, не реализован параллельным вторым контрактом. Все endpoints остаются под session guard; POST также требует same-origin/CSRF, response no-store. Контроллер валидирует Zod, отвечает400 на некорректные IDs/пересечения/время и404 на неизвестную организацию. Никакого network provider request при сравнении.

## Выборки

- Организация: все eligible карты выбранного периода/patch/league; отдельно последние20, native Radiant/Dire и opponent ID breakdown. История организации не называется текущей пятёркой. WR — raw observed wins/N, N0→null, без decay/smoothing/50-50.
- Точная выбранная пятёрка в этой организации: только5 подтверждённых source-account identities на native slots, совпавшие с выбранным fingerprint. Старые победы другой пятёрки не наследуются. Неизвестный/непроверенный input→N=null; известная пятёрка без наблюдений→N0/WRnull.
- Пятёрка/co-play через любые организации: existing roster builder, exact-five/10 unordered pairs/personal/confirmed-role counts/churn. from/cutoff/patch/league применяются к загруженному корпусу;90-day freshness — пересечение с выбранным периодом. Role slots пользователя не объявляются историческими ролями.
- Патч на дату cutoff: resolvePatchAt по reviewed registry на текущий snapshot (retrospective display), без provider-code/catalog fallback. Нет verified patch→currentPatch=null и warning, raw period работает. При explicit patch filter current-patch row — его пересечение с этим фильтром.
- H2H организаций: только фактические карты между двумя выбранными team IDs, единица=map, startedAt<cutoff и completed<=cutoff. Счёт серии не используется. Raw итог считает всё окно; UI показывает последние100 строк и omittedMaps.
- H2H двух выбранных пятёрок: тот же tag-scoped cohort плюс два точных fingerprint. Неполная historical пятёрка даёт matchesSelectedFives=null и coverage warning, не guessed match. Unknown manual input→итог N=null. Actual participants в строке следуют native slots0–4/128–132; A/B не фиксированы за Radiant/Dire, outcome переводится относительно A.

Pro=true/non-conflict/completion и identity/patch/role/series boundaries переиспользуются. Cached player_id не является identity authority. Nick/current-team flag не склеивают людей. Cross-org player history не становится H2H этих организаций. Pro/unfinished/conflict/global missingness counters ортогональны, не обязаны складываться в denominator одного отчёта.

## Сила соперников

`readStrengthHistory` выделен из S1-05 без изменения алгоритма/старого endpoint. Shared global history читается один раз в той же repeatable-read транзакции, затем chronological player-mean Elo вычисляется для A/B. Frozen start ratings, evidence-known updates, microsecond clocks, series-independent single-map semantics и late-conflict stop сохранены.

**Elo имеет отдельный cohort:** последние20 organization maps в выбранном периоде, без patch/league фильтра, с полным earlier global warmup. Input/snapshot/proof manifest/coverage возвращаются внутри strength DTO. UI явно показывает это различие, rated N и число соперников с предыдущей историей. Это unvalidated experimental Elo, не внешний официальный ordinal rank, не текущий рейтинг вручную заданной пятёрки и не вероятность. Если evidence недостаточно, оценка null; if global history>5000 — strength unavailable, raw compare остаётся доступным. Нельзя незаметно сокращать warmup до целевых двух тегов.

## Consistency, bounds и provenance

Один repeatable-read snapshot для names/catalog validation, descriptive inventory, selected-account evidence, registry/identity revisions и global strength warmup. Общий input/from/cutoff/snapshot/source/model и nested proof IDs/data revisions сохраняются в response. Current descriptive evidence не выдаётся за historical-known-asof feature cohort; source fetched after cutoff остаётся явным provenance.

Descriptive inventory ограничен5000 **глобальных candidates выбранного периода**, чтобы cross-org histories сравнивались на общем корпусе. Overflow→whole report unavailable, не truncated result. Это ограничение bounded local MVP, не полный production query optimizer. Strength отдельно ограничен5000 global pre-cutoff candidates за всю историю; overflow не скрывает raw display. Persistent cache/analysis snapshot storage/scenario tables не добавлены; Vue Query cache ephemeral/staleTime0.

## Проверки

`pnpm test:compare`: реальный PostgreSQL + Fastify/owner/CSRF, synthetic isolated data. Unit compare tests входят в pnpm test. Regression existing strength API обязателен после extraction reader. Chromium compare spec проверяет реальный auth/API/tempDB, замену/unknown/empty/error и360px; fixtures не попадают в working DB. Конкретные результаты — [PROGRESS](PROGRESS.md).
