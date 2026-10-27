# Критерии приёмки MVP

## Data: MUST

- Imports use verified OpenDota data, not mock pro statistics.
- `is_pro=true` set only with a professional source; user and hero results exclude non-pro maps.
- One imported map = at most one `matches` row, max ten uniquely slotted `match_players`, every reported pick/ban has source evidence.
- No future maps included in as-of statistics; same match reimport does not change counts.
- `sampleSize=0` yields `winRate=null` and UI says «Нет данных».
- Freshness, filters, scope, `sampleSize`, coverage and warnings visible.

## Product: MUST

- Owner logs in, logs out and cannot access private data after revocation; there is no signup.
- Search two different professional teams; inspect form, exact roster stats, players, heroes and H2H.
- Save a map scenario, manually select 5+5 slots and assign max 10 different heroes, modify and reopen.
- For partial drafts descriptive metrics work; post-draft probability is unavailable.
- Full draft shows player×hero, ally pair, 5×5 opponent matchup matrix and sample sizes.
- Historical analysis snapshots remain stable when scenario updates.

## Prediction: MUST

- Trained/evaluated models registered with feature schema, train/calibration/test dates, Brier, log loss and baseline; no training within HTTP requests.
- Same trained feature code used at inference; no target-map outcome leaks.
- Pre-match model works without heroes; post-draft requires 10 distinct heroes.
- Probability displayed only when model active and quality gate passed; otherwise status unavailable, number null and explanatory warnings.
- Delta percentages only for comparable snapshots, not unrelated revisions.
- Raw retrospective validation and model versions inspectable in app; do not claim accuracy from train data.

## Patch-aware regression gates: MUST

- Один и тот же матч не приписывается патчу по дате импорта: используется подтверждённое время начала карты, при неизвестной версии — NULL/warning.
- Режим «текущий патч» не включает карты других патчей и не подменяет сырой win rate weighted-оценкой.
- Для draft-метрик устаревшие карты проходят через версионированную time+patch+hero policy; для командной силы применяется иная policy, согласованная с temporal backtest.
- Для любой взвешенной оценки раскрыты `n_raw`, `n_eff`, patch breakdown, cutoff, model/policy version и предупреждения.
- Patch cold-start и небезопасный domain shift блокируют невалидированный probability output, но не блокируют descriptive statistics.
- Есть тесты для patch boundary, 3-year-old map discount, hero rework, `n_eff`, ретро-time leakage, нового патча с малой выборкой.
- Проверено качество без весов vs time-only vs time+patch на одинаковом time-separated holdout (включая после крупных патчей).

## Technical: MUST

- `pnpm typecheck`, `pnpm test`, `pnpm build` pass from clean checkout after dependency install.
- DB migrations reproducible; stored scenarios persist after restart; environment template is sufficient for dev.
- API validates bodies/params, session/CSRF, no source token leaks; errors use agreed structured codes.
- Browser UX has loading, empty, stale, error and data quality states.

## Roster/stand-in regression gates: MUST

- Реальная пятёрка восстанавливается из 5 разных players одной стороны карты, а не team tag/`is_current_team_member`; старый состав Team Liquid не подменяет новый.
- История одного игрока и каждой пары игроков сохраняется при переходе в другую команду (при pro scope и cutoff); парные карты не считаются дважды.
- Замену одного игрока корректно описывает overlap 4/5 и 6 из 10 связей, **не 40% снижение силы**.
- `expected_lineup` отдельно от `actual_lineup`, при неизвестном baseline дельта null; пользователь может указать stand-in без предположений об ухудшении.
- В прогнозах есть as-of pair/trio/exact-five samples, churn, data quality; конфигурации с разной доступностью IDs проверяются на coverage.
- Обязательны тесты на переход между организациями, роли, возврат прежнего игрока, future roster leakage и сравнение model ablations `team-only` vs `+individual` vs `+cohesion`.

## Mandatory v3 [P0] integration acceptance gates

1. Вся схема 001–006 применена в правильном порядке к чистой БД; old SQL checksums не меняются.
2. Два разных текущих состава одной организации не объединяются как одна пятёрка; alias без verified identity не склеивает pro career; старые пары сохраняются между организациями.
3. Перед расчётом проверяются `started_at < cutoff_at` **и** допустимость `known_at`/stage для каждого признака. Fetch в 2026 не доказывает pre-match знание в 2024.
4. В BO3 карта 2 не получает результаты карты 2/3 как фичи; карты одного known series остаются в одном temporal fold. BO2 не притворяется бинарной победой серии.
5. Radiant ≠ Team A и ≠ first pick; unknown side/first pick/venue не превращается в presumed defaults. Историческая версия порядка драфта не подменяется новой.
6. Opponent-adjusted strength считается по рейтингу оппонента **до** карты, текущие рейтинги не протекают назад; role confidence/moves и lineup swaps маркируются.
7. Hero availability и patch reworks берутся из source-backed датированных правил; unknown ≠ запрещён или разрешён.
8. В статистике `n_raw`, `n_eff` и shrinkage не смешиваются; zero maps → raw observed rate `null`, маленькая выборка отображается отдельно от smoothed posterior estimate.
9. Data conflicts from providers observable, schema drift does not destroy data, missing GPM/roles/hero metadata remains null.
10. Pre and post map predictions на одном holdout и с отдельной моделью, calibrated Brier/Log Loss, no probability until quality gate; immutable snapshots (включая DB trigger после terminal status) + explicit `data_revision`.

## [P1] and [P2] gates (not blocking P0 MVP)

- [P1] Verify clone `parent_scenario_id` keeps original immutable; outcome link does not mutate prediction; model performance from verified outcomes; venue/stage/draft-order provenance and delta compatibility.
- [P2] If activated, independent series-target evaluation including possible draw for BO2; structural draft features pass incremental temporal ablation.

## Continuous learning architecture v4 — P0 acceptance

- Схема 001→006 применяется последовательно на чистой PostgreSQL; ранее применённые миграции 001–004 не меняют checksum.
- Единственная метка для обучения — проверенный winner завершённой pro-карты, Team A/B всегда сопоставлены Radiant/Dire. Unverified, What-if и пользовательский forecast отклоняются как labels.
- В одной frozen dataset/stage карте соответствует одна строка даже при множестве `prediction_runs`/`prediction_outcomes`; labels не попадают в pre/post features.
- Frozen dataset и терминальный eval нельзя изменять в БД; исправления дают новые версии с manifest/fingerprint.
- Candidate model обучен offline, имеет training run, dataset fingerprint, artifact sha, калибровку и независимый pass gate. Нет победного прогноза без активной прошедшей gate версии.
- Активация/откат атомарны, documented, неактивная/непрошедшая модель не вытесняет действующую; activation audit append-only.
- P1 автоматическое переобучение и promotion не требуются для MVP, но предусмотрен durable job и ручной path; opt-in автоматической активации по умолчанию отключён.
- Проспективные Brier/Log Loss отдельно от ретро-метрик; гипотетические сценарии и predictions после старта карты не попадают в real-world skill evaluation.

## P0 v9 — сырой драфт и пригодность по конкретной задаче

- [ ] 10 финальных героев и 0/11/12 raw picks хранятся раздельно, original `picks_bans` не изменяется.
- [ ] Ошибка timeline не аннулирует автоматически пригодные player/hero facts.
- [ ] Unknown team ID и `series_id=0` не приписываются текущей организации или BO1.
- [ ] `draft_order_valid` только при verified patch/mode validation, иначе `null`.
- [ ] Raw observations и quality assessments append-only; новая политика создаёт новую assessment; DB интеграционные тесты пройдены.
- [ ] Training inclusion рассчитан по stage/cutoff/evidence и не является глобальным флагом карты.

Contract: [DRAFT_DATA_INTEGRITY.md](DRAFT_DATA_INTEGRITY.md).
