# API контракт MVP — `/api/v1`

Все private endpoints требуют авторизованный HttpOnly session cookie. Исключение: `GET /health`, `POST /api/v1/auth/login` и CORS preflight (без приватных данных). JSON BIGINT IDs — **strings** (`"123456789"`). Времена — ISO UTC `Z`.

## Основные маршруты (auth S0-03, S1-01..06, S1-08 и S2-01/02 реализованы; остальные планируются)

S1-08: `POST /teams/compare` — stateless read-only comparison с teamAId/teamBId, manual lineupA/lineupB и optional UTC fromAt/cutoffAt/patchId/leagueId. Требует owner/session/CSRF/no-store. `CompareRequestSchema`/`CompareResponseSchema`: raw organization/recent/current-patch/native-side/opponents, exact-five/cohesion, real H2H и отдельно scoped chronological strength. GET compare из planned API не является вторым реализованным endpoint. [Контракт, denominators и границы](S1_08_TEAM_COMPARE.md).

| HTTP | Путь | Смысл |
|---|---|---|
| POST | `/auth/login` | Login по паролю |
| POST | `/auth/logout` | Revoke session |
| GET | `/auth/me` | Владелец, expiry и CSRF token; настройки ещё planned |
| GET | `/heroes` | Справочник |
| GET | `/teams?query=...` | Поиск команд |
| GET | `/teams/:id` | Команда/состав |
| GET | `/teams/:id/matches` | Карты pro + фильтры |
| POST | `/teams/:id/roster-cohesion` | Read-only расчёт введённой пятёрки и optional baseline (S1-03) |
| GET | `/teams/:id/strength` | Chronological player-mean Elo и сила соперника до карты (S1-05) |
| GET | `/teams/compare?teamA=...&teamB=...` | Сравнение |
| GET | `/players/:id` | Игрок |
| GET | `/players?query=...` | Локальный поиск canonical игроков (S1-01) |
| GET | `/players/:id/matches` | Описательные pro-карты игрока (S1-02) |
| GET | `/players/:id/heroes` | Pro-only hero×confirmed role + per-metric coverage (S1-04) |
| GET | `/scenarios?offset=0` | Список владельца,20 записей + hasMore (S2-01) |
| POST | `/scenarios` | Подтверждённый ручной сценарий5+5 с optional baseline/context (S2-01) |
| GET | `/scenarios/:id` | Данные сценария |
| PUT | `/scenarios/:id` | `{expectedRevision,input}`, атомарно составы/baseline/context (S2-01) |
| GET | `/scenarios/:id/history?offset=0` | Неизменяемые снимки редакций,20 записей + hasMore (S2-01) |
| PUT | `/scenarios/:id/lineup` | Planned; S2-01 использует единый PUT выше |
| POST | `/scenarios/draft-check` | Stateless evidence preview полного ввода, без записи (S2-02) |
| PUT | `/scenarios/:id/draft` | Planned; S2-02 сохраняет героев/баны через единый full PUT |
| POST | `/scenarios/:id/hero-matchups` | S2-03 read-only пары/матрица сохранённой revision; owner/CSRF, raw/prior/candidate weights раздельно |
| POST | `/scenarios/:id/analyses` | Создать расчёт, 202 + id |
| GET | `/analyses/:id` | polling статуса/отчёта |
| POST | `/scenarios/:id/predictions/pre-match` | Предматчевый расчёт |
| POST | `/scenarios/:id/predictions/post-draft` | Расчёт по полному драфту |
| GET | `/scenarios/:id/predictions` | История |
| GET | `/predictions/:id` | Снимок и результат |
| GET | `/models/status` | Качество и readiness моделей |
| POST | `/admin/sync/teams/:id` | Триггер импорта |
| GET | `/jobs/:id` | Статус импорта |

S2-03 `hero-matchups`: `{expectedRevision,fromAt?,patchScope?:'all'|'current'|'specific',patchId?,leagueId?,weights?}`. Saved scenario supplies cutoff and selected heroes; stale revision409, invalid filters400, absent/foreign scenario404. Report200 has per-pair raw N/nullable WR, earlier same-patch reference counts, optional explicit unvalidated draft weights/Kish N_eff, coverage/provenance/fingerprint and null probability. Insufficient draft/unknown current patch/>5000 candidate maps return explicit unavailable; reference overflow disables smoothing only. No snapshot or training writes. [Полный контракт](S2_03_HERO_PAIRS.md).

S0-03: login принимает strict JSON `{login,password}`; unknown fields — 400. Успех login/me: `{owner:{id:uuid,login},expiresAt:ISO,csrfToken:string}`. Session token передаётся только HttpOnly cookie. Logout — 204, revoke и очистка cookies. Ошибки: 401 credentials/session, 403 Origin/CSRF, 429 + Retry-After. API ответы: Cache-Control: no-store.

Login требует Origin, точно совпадающий с WEB_ORIGIN; изменяющие авторизованные запросы также требуют `X-CSRF-Token` из login/me и signed CSRF cookie. CSRF связан с сессией, GET me обновляет token после reload. Scripts/curl должны передавать Origin явно. Production: `__Host-session`/`__Host-csrf`, Secure/HttpOnly/SameSite=Lax/Path=/ без Domain; localhost HTTP: `dota_session`/`dota_csrf`. [Подробно](S0_03_OWNER_AUTH.md).

## Справочники S1-01

S1-01 реализует `GET /heroes`, `/teams`, `/players` и `/teams/:id`, `/players/:id`. Списки принимают strict query `{query?:string<=80,limit?:1..100,offset?:0..10000}`, defaults `""/25/0`. Поиск нечувствителен к регистру, по подстроке имени/тега/internal hero name или точному canonical ID; `%`/`_` — обычный текст. Порядок lower(name), numeric ID, limit+1 даёт hasMore. ID — положительная decimal string в пределах SQL bigint. 400 — invalid query/ID, 404 — неизвестная запись. Все маршруты требуют owner cookie, Cache-Control:no-store.

List DTO: `{kind,items:[{id,name,secondary,syncedAt,metadataUpdatedAt}],hasMore,filters,source:'local_catalog',computedAt,warnings}`. `syncedAt:null` — неизвестная синхронизация; heroes.updated_at возвращается только как metadataUpdatedAt. `GET /teams/:id` возвращает entityType=organization, currentLineup=null, latestObservedLineup из последней завершённой non-conflict pro-карты до cutoff (native side, members/status/source/sync); это не заранее известный/текущий состав. `/players/:id`: entityType=canonical_player, catalogAccountId, accountVerification=not_assessed, currentTeam=null; нет public totals и автоматического объединения по нику. [Полный срез и ограничения](S1_01_CATALOGUE.md).

## Pro-map выборки S1-02

S1-02 реализует `/teams/:id/matches` и `/players/:id/matches`: optional fromAt/cutoffAt UTC milliseconds, patchId/opponentId/leagueId, side, rolePos, limit=10/20/50/100 (default20). Team role filter требует явный playerId; player route берёт target из URL. Ответ scope=retrospective_descriptive, summary raw N/wins/losses/nullable WR/duration, coverage, patchDistribution, maps/proof IDs/revisions/effective filters. started_at<cutoff и end<=cutoff проверяются до JS timestamp rounding. Данные читаются сейчас, не выдаются за historical-asof features. Свыше 5000 кандидатов — 200 status=unavailable/WINDOW_TOO_LARGE, без статистики; invalid query — 400, отсутствующая entity — 404. [Контракт/деноминаторы](S1_02_PRO_MAPS.md).

## Сыгранность и замены S1-03

S1-03 `POST /teams/:id/roster-cohesion`: strict `{lineup:[{playerId,rolePos,isStandin?}]×5,expectedLineup?:five|null,fromAt?,cutoffAt?}`. Read-only, но требует Origin/CSRF как все authenticated POST. Response: actual/expected exact-five, 10 pairs, player/role history, structural comparison, organization churn, coverage/provenance. Current retrospective evidence, не historical feature snapshot; null identity/history и observed zero различаются. Полный [контракт S1-03](S1_03_ROSTER_COHESION.md). Scenario persistence/endpoints остаются S2-01.

## Герои и позиции игрока S1-04

S1-04 `/players/:id/heroes`: strict fromAt/cutoffAt, patchScope=current(default)/all/specific (+patchId), heroId/rolePos/side/opponentId/leagueId. Default period90days; current patch unknown и >5000 candidates дают unavailable с reasons, без fallback. Summary/groups hero×role содержат raw N/wins/WR, KDA и mean K/D/A/GPM/XPM с отдельным nMaps, lastPlayedAt и sync; pick-rate denominator — playerMapsInScope до hero filter. maps/proofs/revisions/quality возвращаются с effective filters. [Полный контракт](S1_04_PLAYER_HERO.md).

## Хронологический рейтинг S1-05

S1-05 `/teams/:id/strength`: strict fromAt/cutoffAt UTC milliseconds, limit20/50/100(default20). Default90day display window, global prior-history replay; >5000 global candidates → unavailable/GLOBAL_HISTORY_TOO_LARGE без target-only truncation. Scope=chronological_retrospective_participation, policy parameters/validation=unvalidated, probability=null. Raw/rated denominators раздельны, ratings/prior/fingerprints/source/proofs/global manifest возвращаются; audit `*Us` clocks — **decimal microsecond strings** для точности, в дополнение к UTC display fields. Поздний proof conflict останавливает replay после своего known time, не переписывает более ранние значения; `replayStoppedAtUs` и причины явны. [Контракт](S1_05_CHRONOLOGICAL_ELO.md).

## Размер выборки и сглаживание S1-06

S1-06 добавляет sampleEvidence (raw N/категория/cold-start, nEff=null для unweighted) в pro-map, roster и player-hero samples. Player hero report дополнен `referencePool` и отдельно названным `smoothing` per-summary/group: earlier same hero×role×patch count prior, same-series exclusion, unavailable reasons, prior-only marker при N0. Reference >5000 отключает smoothing, не raw report; prior stats не являются модельной вероятностью. [Точный контракт](S1_06_SAMPLE_EVIDENCE.md).

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

S2-01 реализует `ScenarioInputSchema`, `UpdateScenarioSchema`, `ScenarioSnapshotSchema`. Не принимает knownAt/recordedAt от пользователя. Snapshot имеет server recordedAt/owner-assertion knownAt, manual source, SHA-256, nullable planned eventAt и `predictionEligibility='not_assessed'`; это не подтверждённый исторический lineup fact. PUT409 сохраняет локальные правки до явного reload; старые snapshots не меняются. Неполные 5+5, неизвестный catalog ID/некорректный series context —400; отсутствующий/чужой сценарий —404. [Полный контракт и границы](S2_01_SCENARIOS.md).

S2-02 добавляет optional `input.draft={assignments:[{teamSlot,rolePos,heroId}],bans:[{teamSlot,heroId}]}` и optional nullable context.leagueId, без defaults в legacy snapshots. Уникальны0–10 hero assignments/slots и все picks+bans; SQL int32 hero IDs, остальные bigint IDs строки. Preview200 возвращает available/unknown/blocked, nullable decisions, proof clocks/refs, registry revision и null probability; сохранение с доказанным запретом —422 DRAFT_UNAVAILABLE без новой revision. Unknown/conflict не подменяются разрешением и явно предупреждают. Frozen `draftAssessment` хранится с input; старые редакции не пересчитываются. Old-client PUT без draft при существующих героях/банах —409; явный пустой draft очищает его новой редакцией. [Контракт](S2_02_DRAFT_LAB.md).

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
