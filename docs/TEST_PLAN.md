# План тестирования

## Unit

1. Metric: `[W,L,W] => n=3,w=2,rate=2/3`, `[] => rate=null`.
2. Ally pair: A,B = B,A; each one side/map counts once; no opposite-team records.
3. Directed matchup A→B: swapping directions flips win count for same map.
4. Team A/B swapping with side switching does not silently preserve reversed probability.
5. Zero deaths in KDA, null gpm/xpm and mixed known/anonymous players.
6. Distinct ten-hero validation; duplicate heroes and same teams rejected.
7. UTC exact cutoff (`started_at == cutoff_at` excluded), patch filtering and pro-only.

## Provider / importer integration

- Happy map from sanitized fixture, no full draft, 404, 429 + Retry-After, 5xx retries, invalid JSON, duplicate map and player_slot, mixed pro/non-pro.
- Daily/monthly quota tracking and worker concurrency. Provider requests use a mocked HTTP adapter in tests.
- Partial data does not erase more complete data with null values on refresh.

## API / Auth

- Unauthorized private route => 401. Owner login => cookie; logout + revoke => 401; CSRF on cookie-mutating requests; no `/signup` endpoint.
- Input bodies parsed by Zod; BIGINT IDs serialized as strings; error code and requestId consistent.
- Stale analysis / cancelled or failed jobs produce honest states.

## Prediction offline

- Features at T invariant under addition of matches with dates >= T.
- Current match score/kills/gpm/outcome never in features; mutate target label and verify features unchanged.
- Series group not split across chronological train/calibration/test.
- Compare pre and post draft metrics on identical match IDs.
- Inactive model => `unavailable`, probability `null`; missing active model => same.
- Poor ECE/Brier or too few holdout examples => gate fails.
- Opponent/team A-B swap property tested; zero/low data warnings.

## UI E2E

- Login/logout, search team, offline provider, change roster, partial/full draft, refresh analysis, save/reopen scenario, analysis run revisions and prediction compare.

## Running locally

`pnpm typecheck && pnpm test && pnpm build`; integration tests requiring PostgreSQL run after `pnpm db:up && pnpm db:migrate`. Additional E2E commands introduced with the first test harness; Codex documents exact changes in PROGRESS.

## Roster continuity

- Одинаковые team_id в разные годы, но непересекающиеся пятёрки: current `exact_five_maps` не захватывает прошлую пятёрку.
- Два игрока переходят вместе из Team X в Team Liquid: их старые `pair_maps` не обнуляются.
- Одна замена: overlap 4 игрока и 6 сохранённых структурных пар из 10; фиксированный штраф отсутствует.
- Stand-in сильнее по личной форме, но имеет меньшую pair history: оба показателя доступны раздельно; нет автоматического вывода победителя.
- Одна карта/одна сторона/пара = одна запись, дедупликация импорта; соперников на одной карте не считать союзниками.
- Missing player ID или <5 известны => exact-five unknown/coverage, не 0; исторические карты с `started_at>=T` недопустимы.
- Исторически текущий флаг API не применять к backtest дате; смены ролей не терять при одинаковых player IDs.
- А/В обмениваются сторонами: история пятёрки независима от team tag, `radiant_slot` учитывается отдельно.

## Regressive tests for v3 additions

- **Temporal semantics:** `event_at`, `known_at`, `fetched_at` independent; info fetched later does not become known in earlier as-of query; negative controls detect target-map outcome leakage; maps of one series cannot span folds.
- **Opponent Elo:** stronger/weaker opponent, chronological update, unseen team, complete roster replacement, team A/B swap.
- **Identity/roles:** alias collision, account transfers, provisional vs verified link, role swap unchanged lineup, 5-player full identity checks.
- **Series/context:** unknown map number, series score, draft order version for old patch, Radiant/first pick independently specified; BO2 draw not binary.
- **Sample size:** `n=0 => rate=null`; `n=5` vs `n=100` shrinkage; weighted `n_eff <= n_raw` with valid positive weights; missing meta flags.
- **Provider conflict:** two providers disagree, select canonical value by documented rule or mark unresolved; repeats are idempotent; audit timestamps preserved.
- **Eligibility:** source-backed hero prohibition active only in its valid interval, unspecified restriction remains unknown.
- **Forecast outcomes:** past `prediction_runs` unchanged after outcome linked; no training outcome from test leakage; score by patch/stand-in segment.
- **What-if (P1):** clone same source snapshot then flip side/stand-in, compare only same conditions/revision and leave original unchanged.

- **SQL immutable prediction (P0):** после фиксации `prediction_runs.status=done/unavailable` попытка UPDATE отклоняется триггером; новая версия создаётся отдельной записью; `prediction_outcomes` остаётся независимой.

## Continuous learning (v4) — P0 contract tests, P1 behavior later

- Проверить SQL: `training_dataset_maps` с неизвестным/nonpro результатом, неверным Team A/B ↔ Radiant, cutoff не равен началу map или неверной label отвергается; duplicate `(dataset_version_id, match_id)` запрещён.
- Frozen dataset header/examples UPDATE/DELETE/INSERT отвергаются; terminal eval и activation audit append-only.
- Исход текущей карты не входит в feature vector, изменение only label не меняет input_hash. Начало матча == cutoff карты, а данные исторических карт строго раньше cutoff.
- В BO3 series целиком в одном fold; unknown match resolution excluded. Смена патча и stand-in не заменяются фиктивными defaults.
- 20 уже сохранённых прогнозов на один pro match не дают 20 train observations. Ручной пользовательский фаворит не считается actual winner.
- Retried training idempotent; job crash/incomplete artifacts нельзя promote; model stage mismatch, SHA mismatch, failed gate, small N запрещают switch.
- Champion retained on challenger failure; success/fallback/rollback records atomic `model_activation_events`. Validate against independent test set and prospective data.
- Retro forecast linked post hoc не входит в prospective metrics; freeze older predictions unchanged when an actual outcome is linked. Выполнить PostgreSQL integration tests реально, не объявлять SQL valid на основании одного parser smoke test.

## v9 — проверка целостности драфта (P0)

До принятия Data Collector выполнить `node --test tests/node/*.test.mjs` и новый `node scripts/audit-prediction-sources.mjs --fixture tests/fixtures/opendota-audit-anomalies-synthetic.json --sample 6`. На PostgreSQL выполнить миграции 001–006, проверить FK к одной карте, raw `picks_bans`, невозможность UPDATE/DELETE observations и assessments, повторный импорт и отсутствие дублирования обучающих карт. Исторический порядок picks/bans не может маркироваться verified без patch+mode validator. См. [DRAFT_DATA_INTEGRITY.md](DRAFT_DATA_INTEGRITY.md).
