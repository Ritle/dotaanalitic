# API контракт MVP — `/api/v1`

## S2-07 — рейтинговая практика (backend reader)

Дополнение известных карт: owner/CSRF `POST /ranked-practice/context`, strict `{playerId, parentObservationId:UUID, refresh?:false}`; cache-only по умолчанию, явное обновление до20 карт/5 batches по4, без произвольных account/map IDs. RankedContextReport: parent window/revision/source/policy, not_loaded/ready/partial/unavailable, reason/retryAt, parentGames/selectedMaps/matchedMaps и строки с sourceReceiptId/sourceParentObservationId/sourceFetchedAt/sourceSha256/stale, nullable estimated position/provider version/average lobby rank. Metadata разрешена только matched строкам. Raw bodies не возвращаются; source knownAt=null, receipts immutable. SQL046/per-map cache24h, negative/conflict1h, account lease120s/shared quota/partial recovery. Core/identity/parent conflicts не меняют основной N/WR. [Инструкция и границы](S2_07_STRATZ_ENRICHMENT.md).

Owner/CSRF `POST /ranked-practice` принимает `{playerId, provider?:'opendota'|'stratz', refresh?:false}`. Current30-day ranked All Pick, только verified account из canonical registry. Cache-only по умолчанию; явное обновление ограничено2 страницами×100 строк. Статусы not_loaded/ready/partial/empty/unavailable/conflict, stale/retryAt, source clocks/hash, identity revision и immutable observation ID. Raw bodies не возвращаются. Pro-отчёты и Elo не используют эти данные. Флаг RANKED_PRACTICE_ENABLED default=false; STRATZ отдельно требует token. [Контракт, хранение и ограничения](S2_07_RANKED_PRACTICE_READER.md).

Текущий adapterVersion `ranked-practice-reader-v2` исправляет полную OpenDota projection. Read contract принимает v1/v2; legacy v1 observation неизменяем и возвращается stale, manual refresh может заменить cache pointer до прежнего TTL, но lease/cooldown не обходятся. Новые publications только v2.197 реальных ranked-карт проверены в [coverage control](S2_07_RANKED_COVERAGE_CONTROL.md).

Additive [hero summary](S2_07_RANKED_HERO_SUMMARY.md): `statisticsEnabled:true` только для verified OpenDota v2 observation без source conflicts; `heroSummary` содержит observationId, policyVersion=`ranked-hero-raw-v1`, roleScope=`all_roles`, weighted=false, totals games/wins/nullable winRate/lastPlayedAt и heroes с такими же полями плюс heroId/nullable heroName. N=0 даёт null rate/recency и пустые heroes. Partial/stale observation сохраняет показатели и предупреждения. STRATZ/v1/недоступная identity возвращают false/null; старый false DTO без heroSummary читается с null. Суммы/группы/source/identity/observation проверяются контрактом. Расчёт на чтении без дополнительного provider HTTP/нового REST route или SQL.

## S2-01 — подготовка заявки в каталоге (2026-11-04)

Общий каталог: owner/CSRF `POST /upcoming/:id/catalogue/prepare` с `{}` или `{externalSearch:false}` возвращает статусы и кандидатов всей заявки, nullable registry SHA и optimistic `linkToken`. Режим false исключает внешний поиск по отдельным никам; optional `reason: external_search_deferred | source_unavailable` отличает отложенный поиск от сбоя. Подготовка предпочитает точные имена/псевдонимы частичным совпадениям, сохраняет неоднозначные точные совпадения и не трактует числовой ник заявки как Steam32. В state игроки также получают token. `/search` local-first, с наблюдавшимися aliases и bounded OpenDota name-search; `discovery:true` требует отдельной проверки числового профиля. В `/apply` добавлены optional `localPlayerId`, `linkToken`, nullable `registrySha256`; только проверенные local IDs допускаются без провайдера. Binding.source может быть `local` и содержит immutable `localCards`. Частичная недоступность поиска передаётся как warning. [Полный порядок и совместимость](S2_01_UNIFIED_PLAYER_CATALOGUE.md), [автоматическая подготовка](S2_01_AUTOMATIC_ROSTER_PREPARATION.md).

Числовой профиль: `/search` players принимает Steam32, Steam64 или HTTPS-ссылку STRATZ/OpenDota/Dotabuff/Steam. Ссылка только разбирается; HTTP всегда к фиксированному OpenDota host. Если числового аккаунта нет в `/proPlayers`, используется `/players/:id` с отдельными sourceEndpoint/hash/fetchedAt и `registrySha256`. У кандидата и выбранной пары optional `profileSha256`; `/apply` проверяет этот SHA отдельно, изменившийся источник→409. В `binding.source.profiles` записываются accountId/hash/fetchedAt, а numeric evidence имеет policy `reviewed-current-profile-v1`, current knownAt=fetchedAt. Старые запросы без новых полей совместимы. Nickname-поиск проверяет и зарегистрированное имя, и personaname, но не вызывает глобальный STRATZ search.

Дополнение новой организации: `teamProvider:'pandascore'` в `/apply` требует `teamId===providerTeamId` из выбранной заявки; каноническая организация создаётся в отдельном namespace, без выдуманного Steam team ID. При отсутствии поля действует прежний OpenDota-путь. Числовые аккаунты в обоих режимах проверяются по OpenDota. Search sourceEndpoint различает `/proPlayers`, `/teams` и `/teams/:id`; hash команды не заменяет registry hash игроков. В binding.source.team сохраняется отдельное происхождение организации. Старая сериализация без новых optional-полей продолжает читаться. Stale-заявка при сохранении обновляется штатно один раз; изменившийся SHA→409.

Owner-only `GET /upcoming/:id/catalogue`, CSRF-protected `POST /upcoming/:id/catalogue/search` и `/apply`. Search возвращает до25 кандидатов OpenDota с числовым ID и source clock/hash. Apply принимает явно выбранный **OpenDota** `teamId`, пять разных PandaScore-player/Steam32 пар, owner confirmation, request UUID, expected revision и source SHA; ответ содержит **локальный** `teamId` и canonical player IDs. Namespace запросов и ответа различаются явно по контракту. Не передавать PandaScore ID в поле OpenDota account ID. Полные Zod-контракты: `packages/contracts/src/roster-catalogue.ts`; [поведение, ограничения и replay](S2_01_EXPECTED_ROSTER_CATALOGUE.md). Никаких вероятностей, импорта карт или автоматической идентификации по нику на этих маршрутах.

S4-01 implemented: ранний router malformed URL →400 VALIDATION_ERROR, oversized path parameter →414 URI_TOO_LONG, внутренняя framework failure →500 INTERNAL_ERROR. Ответ `{error:{code,message,requestId}}` на русском, no-store, без переданного path/error.message. Эти parse errors происходят до owner hooks и не выдают private data. Private route/session/CSRF/Origin протоколы прежние. [Матрица49 routes и ошибки](S4_01_V1_SECURITY_REVIEW.md).

**S4/V1 model readiness (implemented):** GET `/models/readiness`, owner session/no-store, strict empty query. DTO `V1ModelReadinessSchema`: pre_match, checkedAt UTC, unavailable + NO_ACTIVE_MODEL/ACTIVE_MODEL_EVIDENCE_INVALID или model_eligible + reason:null; modelId/reportSha256 связаны со статусом, teamAWinProbability всегда null. Прежний registry gate, без inference/training/activation. Max20/min и одна concurrent check на API;429/Retry-After, MODEL_CHECK_BUSY при занятом admission. Ошибки чтения/DTO — безопасный500, не ложный NO_ACTIVE_MODEL. [Семантика и Home](S4_V1_MODEL_READINESS_STATUS.md). Другие model/admin routes ниже остаются planned, если явно не отмечены реализованными.

**S3-07 scheduled lifecycle:** GET/POST `/schedule-targets/:targetId/lifecycle`. Body requestId/expectedRevision/action/eventAt/sourceUrl/reason/confirmedByOwner:true; owner/target из сессии и пути. Owner/session/no-store, POST Origin/CSRF/6min и bounded admission. History20 с exclusive beforeRevision, без ownerId; состояние общее для всех редакций встречи. Journal view допускает lifecycle PandaScore и policy v2; optional verifiedScheduleBindingKnown сообщает о ранее подтверждённой связи до outcome refresh. [Полный контракт](S3_07_V1_SCHEDULED_TARGET_LIFECYCLE.md).

**S3-07 scheduled binding owner flow:** scoped `/schedule-targets/:targetId/forecasts/:forecastId/result-binding` GET/POST и `/outcomes` GET/POST. Owner/session/no-store; POST Origin/CSRF/6min и общая result-write admission. Bind body requestId/matchId/providerSeriesId/sourceUrl/rationale/confirmedByOwner:true; refresh — только requestId/expectedRevision. Owner/forecast/target/map выводятся сервером, scope проверяется до repo retry lookup. Outcome history20 с exclusive beforeRevision cursor. HTTP projection исключает raw observation JSON/owner/code/payloads. [Контракт](S3_07_V1_SCHEDULED_BINDING_OWNER_FLOW.md).

**S3-07 scheduled owner flow:** POST/GET `/schedule-targets/:targetId/forecasts`, GET `/schedule-targets/:targetId/forecasts/:requestId` — owner/session/no-store; POST Origin/CSRF,6/min, общая admission с what-if. Строгий body requestId/scenarioId/expectedRevision/targetSha256/targetScope; provider selector строится сервером из immutable target. Отдельная real_map projection и bounded history20; прежний what-if контракт сохранён. [Подробности и границы](S3_07_V1_SCHEDULED_OWNER_FLOW.md).

**S3-07 scheduled result:** owner CLI forecast:v1 bind принимает requestId/predictionRequestId/targetSha256/matchId/providerSeriesId/sourceUrl/rationale, binding читает сохранённый request ID. Победитель и reviewedAt во входе запрещены. После сохранения связи прежний refresh работает для PandaScore target. Outcome и journal view получили optional scheduleBinding/scheduleResultBinding с SHA, IDs, source URL, server review time и owner-reviewed basis; прежние payloads совместимы. Новых HTTP mutation routes нет. [Контракт](S3_07_V1_SCHEDULED_RESULT.md).

**S3-07 scheduled runtime:** owner CLI `forecast:v1 create|get` принимает `real_map` с `realTarget:{provider:"pandascore",bindingVersion:1,providerMatchId,mapNumber:1,targetRequestId,targetSha256}`. SHA/UUID ссылаются на сохранённую последнюю редакцию назначения. Старый OpenDota selector сохранён. `V1JournalView` дополнен этой разновидностью target и ссылкой на saved target; никаких новых HTTP create routes, сценарный endpoint остаётся what-if. Refresh такого исхода пока возвращает `forecast_schedule_binding_required`; target provider ID не подставляется в OpenDota series ID. [Полный контракт](S3_07_V1_SCHEDULED_RUNTIME.md).

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
| POST | `/scenarios/:id/analyses` | S2-04 synchronous snapshot:201 + immutable report;200 unavailable,409 stale revision |
| GET | `/scenarios/:id/analyses` | S2-04 history summaries, offset/20 + hasMore |
| GET | `/analyses/:id` | S2-04 immutable full report, owner scoped |
| POST | `/scenarios/:id/predictions` | S3-06: условная одна карта, immutable attempt и exact requestId retry |
| GET | `/scenarios/:id/predictions?offset=0` | S3-06: история владельца, 20 записей + hasMore |
| GET | `/scenarios/:id/predictions/:requestId` | S3-06: сохранённый результат без пересчёта |
| POST | `/scenarios/:id/predictions/pre-match` | Planned; V1 использует POST выше |
| POST | `/scenarios/:id/predictions/post-draft` | Planned: расчёт по полному драфту |
| GET | `/predictions/:id` | Planned; V1 читает по scenario/requestId выше |
| GET | `/models/status` | Качество и readiness моделей |
| POST | `/admin/sync/teams/:id` | Триггер импорта |
| GET | `/jobs/:id` | Статус импорта |

S3-06 V1 predictions: strict `{requestId,expectedRevision,purpose:'what_if_single_map',targetScope}`; owner берётся из сессии, scenarioId из URL. `200` содержит неизменяемую ограниченную проекцию снимка с null probability при unavailable; exact retry возвращает прежний результат после правок сценария. POST: owner/CSRF/Origin, 6 запросов/минуту, один активный расчёт; 409 conflict, 429 busy/rate limit. GET не пересчитывает историю. [Подробный контракт и UI](S3_06_V1_OWNER_API_UI.md). Реальная карта, её outcome и prospective performance пока не подключены.

S2-03 `hero-matchups`: `{expectedRevision,fromAt?,patchScope?:'all'|'current'|'specific',patchId?,leagueId?,weights?}`. Saved scenario supplies cutoff and selected heroes; stale revision409, invalid filters400, absent/foreign scenario404. Report200 has per-pair raw N/nullable WR, earlier same-patch reference counts, optional explicit unvalidated draft weights/Kish N_eff, coverage/provenance/fingerprint and null probability. Insufficient draft/unknown current patch/>5000 candidate maps return explicit unavailable; reference overflow disables smoothing only. No snapshot or training writes. [Полный контракт](S2_03_HERO_PAIRS.md).

S2-04 analyses принимает такой же strict query с expectedRevision; full saved scenario supplies manual inputs/cutoff. Atomic report version stores full results, source/revisions/fingerprints and null prediction. One repeatable-read snapshot composes existing organization/roster/player-role-hero/pair/strength readers plus selected hero meta; raw/adjusted cohorts remain explicit.201 response `{id,version,createdAt,resultHash,report}`; unavailable windows/unknown current patch do not persist a row. GET never recomputes. [Контракт и схема017](S2_04_SCENARIO_REPORTS.md).

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

S3-07 backend/CLI дополнительно принимает `real_map` с immutable explicit target и versioned verified-outcome refresh. **Это не расширение HTTP create прогноза:** существующий scenario owner API/UI принимает только `what_if_single_map`, история фильтрует этот purpose и не выдаёт real-map snapshot через старый route. Отдельные HTTP endpoints aggregate journal реализованы ниже; создание real-map назначения и первичный outcome refresh пока CLI. [Backend-контракт и ограничения](S3_07_V1_REAL_TARGET.md).

S3-07 metrics backend/CLI: `V1JournalRequestSchema` принимает requestId и filters (`fromAt`, exclusive `until`, modelId, status); `V1ForecastJournalReportSchema` сохраняет frozen input SHA, revision/parent и summary. `journal:v1 create|get|export` использует одного активного CLI-owner. Репозиторий выбирает global primary до фильтров, перепроверяет локальные bound outcomes в repeatable-read capture, возвращает исходный отчёт при exact retry. В старом v1 report `cancelled:null` сохраняется; новые отчёты v2 используют числовой счётчик ручных отмен. Защищённые create/read/history endpoints описаны ниже. [Полные правила](S3_07_V1_JOURNAL_METRICS.md).

S3-07 owner HTTP реализован2026-11-03: POST `/api/v1/forecast-journal` принимает `V1JournalCurrentRequestSchema` (включая `status:"cancelled"`); GET того же пути — `V1JournalHistorySchema` (exclusive beforeRevision,20 версий); GET `/:requestId?offset=0` — `V1JournalViewSchema` (50 строк). Session owner, CSRF/Origin POST, no-store; шесть POST/min и admission одного создания. Full-summary метрики сохраняются при пагинации; raw input/code/payload/owner UUID не возвращаются. Строки содержат expected5v5, original calculation status/reasons, snapshot SHA, outcome receipt metadata и roster status. Exact retry/409 conflict,422 limit,503 integrity; invalid input400/foreign404. [Полный контракт и экран](S3_07_V1_JOURNAL_OWNER_API_UI.md). Real-target create/первичный refresh пока остаются CLI.

Startup fingerprint service/repository проверяется до нового journal INSERT; изменённый расчётный код даёт503/JOURNAL_CODE_CHANGED без записи, сохранённые GET/exact retry не требуют новой capture. Клиент распознаёт только проверенный code и показывает фиксированное русское сообщение о перезапуске; server error message не отображается напрямую.

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

## S1-10 — private upcoming schedule

S3-07 дополнение: [schedule-target registration](S3_07_V1_SCHEDULE_TARGET_REGISTRATION.md). GET `/api/v1/upcoming/:id/target-preview`, GET `/api/v1/upcoming/:id/targets?beforeRevision=…`, POST `/api/v1/schedule-targets`, GET `/api/v1/schedule-targets/:requestId`. Owner session/no-store; POST CSRF/Origin, max12/min. Strict request содержит source observation ID/SHA, expectedRevision, map1 и ручное provider→canonical A/B сопоставление. Ответ record/SHA immutable; exact retry возвращает прежнюю запись. Это pending назначение, probability:null, без прогнозного расчёта. Идентификаторы PandaScore не преобразуются в OpenDota ID. Часы устанавливает сервер; source/revision conflict409, повреждение integrity503, чужая сохранённая запись404.

GET `/api/v1/upcoming` и GET `/api/v1/upcoming/tournaments/:id` читают только кэш; соответствующие POST routes с `/refresh` обновляют отсутствующий/истёкший snapshot. Требуются owner session, для POST также Origin/CSRF и пустой JSON body. GET/POST ответы no-store. Турнир разрешён только при наличии ID в сохранённом расписании; unknown query/body fields и невалидный decimal ID дают400, отсутствующий турнир404.

DTO в `packages/contracts/src/upcoming.ts`: status ready/stale/unavailable, snapshot с data/source или null, computedAt/expiresAt/retryAt, configured/refreshing и безопасный reason. API хранит отдельные provider IDs как строки; не выдаёт token/raw provider error body. Snapshot содержит expected tournament roster, не actual map lineup/roles. Создание сценария использует существующий POST `/scenarios` с ручными canonical IDs и confirmedByOwner, не импортирует PandaScore IDs. [TTL/leases/quota и UI](S1_10_UPCOMING_UI.md).

## S1-14 — обновление описательной pro-истории

GET/POST `/api/v1/teams/:id/history-refresh` возвращают `HistoryRefreshResponseSchema` (`packages/contracts/src/history-refresh.ts`): canonical teamId, available, retryAt, nullable run и безопасное сообщение. Run: UUID, queued/running/completed/partial/error, timestamps, attempt, selected/processed/accepted/duplicates/excluded/sourceErrors/conflicts. Provider payloads, credentials и pg-boss error output не возвращаются.

Owner обязателен для обоих методов; POST дополнительно требует Origin/CSRF и пустые query/body, возвращает202 с новым либо прежним run. Невалидные поля400, отсутствующая организация404, очередь недоступна503. Без source numeric ID — available:false/run:null без enqueue. GET не вызывает провайдера; может согласовать cancelled/failed/lost queue job с сохранённым состоянием run. POST атомарно сохраняет run+job, deduplicate по canonical организации, cooldown5мин после completed. Worker использует общий bounded S1-13 pipeline и per-map idempotent importer. [Запуск, retry/fencing и UI](S1_14_HISTORY_REFRESH.md).


S3-07 lifecycle2026-11-03: [контракт отмен](S3_07_V1_TARGET_LIFECYCLE.md), `V1LifecycleRequestSchema` / owner CLI `target:lifecycle append|history`. Новых HTTP mutation routes нет. Journal projection содержит nullable lifecycle (последний frozen event без ownerId + SHA), original calculation reasons и предупреждение о приоритете verified binding. Current filters/status расширены отдельно от прежнего v1 schema; v1/v2 reports читаются по своей версии. Legacy cancelled null не превращается в0.
## S2-01: текущие профили ролей (owner-approved2026-11-04)

`POST /api/v1/lineup-role-profiles` — owner/CSRF/no-store, `teamId`, до5 разных локальных `playerIds`, optional UTC cutoff и `refreshProfiles=false`. Versioned role-only report содержит profile source clocks/hash/status, verified account resolution, owner-selected binding revision, pro-history alternatives, nullable conflicts и `canAutoApply`; это не historical feature reader и не probability endpoint. `GET/POST /api/v1/teams/:id/role-profile-binding` читает/добавляет owner/team binding revision; POST требует UUID requestId, expectedRevision и явный owner selection, replay идемпотентен, stale→409. [Полный контракт](S2_01_ROLE_PROFILES.md).

## Selected player pro-history — S2-01

Owner/CSRF POST /api/v1/players/history-refresh accepts exactly five distinct canonical playerIds, returns202 queued/reused run. GET with comma-separated playerIds returns availability, current identity-bound run/report/cooldown; no provider calls. Details: [contract and usage](S2_01_PLAYER_HISTORY.md).

Selected-player history depth: optional windowDays=90|180|365|730 and maxMaps=10|25|50 on GET/POST; omitted values preserve90/10. Response options and v2 report preserve the chosen window/depth.409 PLAYER_HISTORY_ALREADY_RUNNING prevents overlapping options for the same five. GET cache identity includes options. [Usage](S2_01_PLAYER_HISTORY.md).


## Personal history report v3 — evidence enrichment (2026-11-05)

Existing owner/CSRF GET/POST players/history-refresh and option/cache/queue contracts unchanged. Report policy selected-player-history-v3 adds optional enrichment; legacy v1/v2 reports remain readable. Fields: status(completed|partial|unavailable), accountsConsidered<=500, accountsVerified<=100, profilesRequested<=20 (profile lookups including cache), unresolvedAccounts, seriesCreated, seriesBlocked, replayedMaps<=50, reasons, nullable assessedAt and five player rawMaps/eligibleMaps counters when assessed. Import status and enrichment status are independent. Null assessment is not zero history. Counters follow the frozen V1 adapter/cutoff/warmup and are not model-validation or activation claims.

Only already accepted map participants are candidates for numeric enrichment. Shared catalogue TTL/leases and provider quota apply; no nickname identity merge, conflict overwrite, backdated known_at, synthetic production inference or probability. Internal source_audit.enrichmentEvidence stores successful numeric reviews/source clocks/SHA and series plan fingerprints. Current in-memory full capture replay needs no second detail request. Existing receipts persist a projection and cannot substitute for full original bytes. A separate evidence-only retry endpoint is not implemented in this slice. See [usage](S2_01_HISTORY_ENRICHMENT.md).


### Schedule freshness admission (SQL044)

`GET /api/v1/upcoming/:id/target-preview` сохраняет прежний формат, дополняя `reasons` значениями `SCHEDULE_SOURCE_STALE` / `SCHEDULE_SOURCE_CLOCK_INVALID` и `eligible:false`. Источник выбранной встречи должен удовлетворять `0 <= checkedAt - fetchedAt < 5 minutes`; новое наблюдение, не содержащее встречу, не продлевает её срок. GET cache-only. Новые POST назначения и scheduled forecast возвращают HTTP409 `schedule_source_stale` / `schedule_source_clock_invalid` с русским сообщением/requestId. Exact persisted retry и read/history не требуют заново свежего источника. Guard в SQL проверяет фактическое время после расчёта и атомарно откатывает новую попытку при истечении срока. Обновление — прежний owner/CSRF `POST /api/v1/upcoming/refresh`, с общими lease/quota/TTL/Retry-After; автоматических provider requests нет. [Полный контракт](S4_V1_SCHEDULE_FRESHNESS.md).

### Schedule pages (SQL047)

`GET /api/v1/upcoming?page=N` is cache-only. Owner/CSRF `POST /api/v1/upcoming/refresh?page=N` uses a per-page lease/5-minute TTL and shared PandaScore quota/Retry-After; no body fields. Page is an optional canonical decimal string 1–50 (default1), per_page fixed20; unknown/repeated/invalid query fields ->400. Page1 retains its existing response and immutable source history. Separate validated page2–50 responses use the exact requested source endpoint, unknown knownAt and actual fetchedAt/SHA. Errors preserve stale cache; no fallback to another page. Existing tournament/roster-catalogue endpoints accept valid cached later-page context without fetching additional schedules. Duplicate match IDs across pages resolve to the most recently fetched observation; absence on another page does not prove cancellation. Frozen forecast-target APIs remain page-one-only. [Behavior and limits](S1_16_SCHEDULE_PAGES.md).

### Player history evidence resume (SQL043)

POST /api/v1/players/history-refresh/resume — owner/session/CSRF, strict body {runId: UUID}, no query fields. Returns202 PlayerHistoryResponse; concurrent/cooldown retry returns the existing run. Invalid/unowned/nonresumable source or changed numeric identities ->409 PLAYER_HISTORY_RESUME_UNAVAILABLE; malformed input ->400. Same-five overlapping options ->409. No user-supplied map IDs or source URLs. GET history-refresh is unchanged, with optional canResume. Runs expose optional operation/parentRunId.

Resume creates a distinct evidence_resume run referencing the original import and accepted/duplicate map scope (<=50). Report selected-player-history-v4 requires operation/parentRunId; v1–v3 remain readable. No discovery/detail/reference HTTP: only bounded identity catalogue/profile enrichment. Preserved projections are explicitly derived, with new SHA/clocks/adapter and parent receipt/reference lineage; original provider bytes are not claimed. Missing stored evidence -> partial STORED_PROJECTION_UNAVAILABLE without automatic re-fetch. No prediction/model activation. [Contract/usage](S2_01_HISTORY_ENRICHMENT_RESUME.md).
