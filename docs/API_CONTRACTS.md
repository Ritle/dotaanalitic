# API контракт MVP — `/api/v1`

Все private endpoints требуют авторизованный HttpOnly session cookie. Исключение: `/health` и `POST /api/v1/auth/login`. JSON BIGINT IDs — **strings** (`"123456789"`). Времена — ISO UTC `Z`.

## Основные маршруты (планируемые; пока не реализованы)

| HTTP | Путь | Смысл |
|---|---|---|
| POST | `/auth/login` | Login по паролю |
| POST | `/auth/logout` | Revoke session |
| GET | `/auth/me` | Владелец и настройки |
| GET | `/heroes` | Справочник |
| GET | `/teams?query=...` | Поиск команд |
| GET | `/teams/:id` | Команда/состав |
| GET | `/teams/:id/matches` | Карты pro + фильтры |
| GET | `/teams/compare?teamA=...&teamB=...` | Сравнение |
| GET | `/players/:id` | Игрок |
| GET | `/players/:id/heroes` | Pro-only статистика по героям |
| POST | `/scenarios` | Сценарий: 2 команды |
| GET | `/scenarios/:id` | Данные сценария |
| PUT | `/scenarios/:id/lineup` | Атомарно 5+5 игроков |
| PUT | `/scenarios/:id/draft` | Выбранные герои / баны |
| POST | `/scenarios/:id/analyses` | Создать расчёт, 202 + id |
| GET | `/analyses/:id` | polling статуса/отчёта |
| POST | `/scenarios/:id/predictions/pre-match` | Предматчевый расчёт |
| POST | `/scenarios/:id/predictions/post-draft` | Расчёт по полному драфту |
| GET | `/scenarios/:id/predictions` | История |
| GET | `/predictions/:id` | Снимок и результат |
| GET | `/models/status` | Качество и readiness моделей |
| POST | `/admin/sync/teams/:id` | Триггер импорта |
| GET | `/jobs/:id` | Статус импорта |

## DTO: ошибка

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Некорректные данные", "details": { "field": "teamAId" }, "requestId": "..." } }
```

Codes: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `DATA_INCOMPLETE`, `MODEL_NOT_READY`, `INTERNAL_ERROR`.

## DTO: rate

```json
{
  "games": 0, "wins": 0, "winRate": null,
  "sampleSize": 0,
  "filters": { "scope": "pro", "patchId": null, "cutoffAt": "2026-10-27T00:00:00Z" },
  "coverage": { "eligibleMaps": 0, "knownPlayers": 0 },
  "source": "opendota_normalized",
  "dataUpdatedAt": null,
  "computedAt": "2026-10-27T00:00:00Z",
  "warnings": ["NO_PRO_MATCHES"]
}
```

`winRate` is decimal fraction **0..1**, not percentage in transport. UI may display `100 × winRate`%. In response `null` is not a 0% win chance.

## DTO: prediction

```json
{
  "id": "uuid", "scenarioId": "uuid", "scenarioRevision": 1,
  "stage": "post_draft", "status": "unavailable", "model": null,
  "teamAWinProbability": null, "teamBWinProbability": null,
  "preMatchProbability": null, "deltaPercentagePoints": null,
  "cutoffAt": "2026-10-27T00:00:00Z",
  "quality": { "testGames": 0 }, "coverage": { "assignedHeroes": 10 },
  "warnings": ["MODEL_NOT_READY"], "explanations": []
}
```

Выше **пример отсутствия модели**, не mock реального результата. `done` разрешён только после наличия опубликованной модели и пройденного quality gate. Для частичного драфта ответ `422 VALIDATION_ERROR` или `unavailable` с `INCOMPLETE_DRAFT` по зафиксированному контракту; выбрать и закрепить один вариант в коде и тестах (предпочтение: 422 для неполной заявки, unavailable — для валидной заявки без модели).

## Идемпотентность и редакции

Сценарий содержит `revision`; PATCH/PUT модификации должны валидировать expected revision (optimistic lock) и увеличивать её на 1. Прогноз всегда ссылается на revision и хранит входной snapshot. Ранее сохранённые вычисления не изменяются.

## Roster continuity routes (planned, not implemented)

| HTTP | Path | Contract |
|---|---|---|
| PUT | `/scenarios/:id/expected-lineup` | Upsert optional baseline 5 roles each; `expectedRevision` optimistic lock; manual/observed suggestion + confirmation. |
| GET | `/scenarios/:id/roster-cohesion` | Derived pro-only snapshot for 5+5, `cutoffAt`, `n`, cross-org pair maps, exact-5, known-IDs coverage, expected-vs-actual delta/warnings. |

Return `roster: { teamA: { exactFiveMaps, pairMaps: [{ playerAId, playerBId, games, wins, lastPlayedAt }], knownPlayers, observedMaps }, teamB: { ... } }`. `exactFiveMaps=0` is possible even with five known IDs (no observed matches). If an ID is not known, counts dependent on it are **null** and `warnings` includes `UNKNOWN_PLAYER_IDS`. `expectedVsActual` is `null` if the optional baseline cannot be established. `teamA`/`teamB` remain UI slots, not Radiant/Dire. This endpoint is descriptive, no probability. `PUT` increments scenario revision; existing prediction snapshots immutable.

## Planned v3 context, lineage and evaluation extensions

Все DTO ниже **планируемые**, не реализованы в стартовом каркасе.

- `GET /api/v1/scenarios/:id/context` — `mapNumber`, `seriesScoreBefore`, `radiantSlot`, `firstPickSlot`, `draftOrderVersion`, `venueKind`, `knownAt` per available field, `warnings` for unknown. Never infer unknown Team A/Radiant/first pick.
- `PUT /api/v1/scenarios/:id/context` — owner edit with `expectedRevision`, explicit `sourceKind='manual'`, stable revision. Параметры unknown nullable.
- `GET /api/v1/players/:id/identity` — canonical id, verified related accounts and alias history; provisional links explicitly marked, no auto merge.
- `GET /api/v1/scenarios/:id/data-quality` — known lineup slots/roles, verified patch, hero availability status, `nRaw`, `nEff`, `sourceConflicts`, `lastSync`, provider coverage.
- `POST /api/v1/scenarios/:id/clone` **[P1]** — create what-if branch with `parentScenarioId`; no mutation to previous snapshots.
- `GET /api/v1/models/performance` **[P1]** — actual matched-outcome holdout-only Brier, LogLoss, calibration and group cuts, count/date/source/version; no fake model metrics.
- `POST /api/v1/predictions/:id/link-outcome` **[P1]** — attach verified actual `matchId`/winner without modifying original prediction.

Recommended response metadata for every report/prediction: `{cutoffAt, stage, featureSchemaVersion, dataRevision, sources:[...], context:{...}, coverage:{nRaw,nEff,knownRoles,knownPlayers,...}, warnings:[...]}`. Missing booleans remain `null`. Pre-map probability predicts a **map**, never the series. `modelConfidence` must not masquerade as game-win probability.

## v4: training/model lifecycle endpoints (planned, owner-only)

P0 architecture needs **internal CLI/service**, not a new public endpoint: `DatasetBuilder`, offline `train`, `evaluate`, `activate` and `rollback`. Do not train synchronously from `POST /predictions`. IDs UUID; timestamps UTC; model artifacts checked by SHA-256.

**P1**, only after quality-gated offline pipeline:

| HTTP | Path | Response |
|---|---|---|
| GET | `/api/v1/models/history` | active candidate history, stage, dataset fingerprint, eval records, no secrets |
| GET | `/api/v1/models/performance` | separate `prospective` and `retrospective` sections, Brier, Log Loss, N |
| POST | `/api/v1/admin/models/retrain` | enqueue durable batch job, returns `202 {jobId}`, idempotency key |
| POST | `/api/v1/admin/models/:id/activate` | owner-reviewed approved candidate only, compare-and-swap stage |
| POST | `/api/v1/admin/models/:id/rollback` | owner-reviewed previously passing model, audited rollback |

User forecasts/guesses (future) are **not** verified labels. `prediction_outcomes` can be linked to a specific real map only when context and pre-start timestamps are verified; this link never modifies immutable `prediction_runs`. New verified pro matches are taken **directly from canonical matches** for the next frozen training dataset, not reconstructed from user prediction rows.
