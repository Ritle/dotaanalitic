# Критерии приёмки MVP

**S4/V1 audit, 2026-11-03:** [матрица требований и доказательств](S4_V1_ACCEPTANCE_AUDIT.md) отделяет реализованные протоколы от условий выпуска. Журнал V1, [проверка владельца](S4_V1_LOCAL_OWNER_SMOKE.md), [фильтр турниров](S4_V1_SCHEDULE_EVENT_FILTER.md), [Home registry status](S4_V1_MODEL_READINESS_STATUS.md), [owner HTTP security review](S4_01_V1_SECURITY_REVIEW.md), [native pg-boss queue restore coverage](S4_01_V1_QUEUE_COVERAGE.md) и [upstream resilience review](S4_01_V1_PROVIDER_RESILIENCE.md) реализованы/проверены в описанной области. Home probability всегда null, реальный forecast требует собственных gates. Полная78-entry сверка закрыла S4-SEC-03 текущего verifier; durable Retry-After OpenDota исправлен для всех 5xx. [Review провайдерских конфликтов](S4_01_V1_PROVIDER_CONFLICTS.md) завершён: новые8 cases включены в test:pro-maps/CI, runtime не менялся; S4-01 закрыт в текущей localhost V1 области. [S4-02 historical regression](S4_02_V1_HISTORICAL_REGRESSION.md) пройдена на frozen232-map development snapshot; это совпадение признаков, не независимая оценка точности. [Full owner E2E](S4_02_V1_FULL_OWNER_E2E.md)57/57 пройден на изолированных данных; S4-02 закрыт в текущей localhost V1 области. Общая приёмка ждёт независимой оценки модели и restore с реальной active моделью; Docker/VPS/remote CI этим не подтверждены.

## Приёмка первого прогнозного выпуска V1

- Scope уточнён владельцем2026-11-02: будущие прогнозы MVP для явно выбранных Tier 1 events/editions; Tier 2 — после MVP. Event selection фиксируется до новых test outcomes, качество проверяется на target domain. `is_pro`/`premium` не подменяют Tier 1 membership. Другая verified pro-history не удаляется автоматически; вне prediction scope описательная аналитика сохраняется. Owner-reviewed Tier 1 scope проверяется runtime; фильтр по provider tournament ID реализован для выбранной сохранённой страницы расписания, с явным partial scope и без присвоения Tier1. Назначение и runtime adapter поддерживают загруженные страницы1–50 с сохранением настоящего источника, пяти минут свежести и всех model gates. [Контракт](S3_07_SCHEDULE_PAGE_TARGETS.md). Качество на целевом домене ещё требует независимого release test. [Сверка6 ноября](V1_REQUIREMENTS_REVIEW_2026_11_06.md).

[TECHNICAL_SPEC §0](../TECHNICAL_SPEC.md) определяет отдельный первый выпуск; критерии полного двухмодельного MVP ниже не должны возвращать отложенные зависимости в V1.

- Expected 5v5 можно ввести/изменить без официального roster announcement; ten distinct verified account identities, source/time/revision сохраняются. Unknown/duplicate identity блокирует, missing role/patch/draft — нет.
- Одна pre-match player-Elo модель без героев, ролей, patch/side/cohesion features. Исторические native sides используются только для корректных lineups/labels; Team A/B сценария не назначаются Radiant/Dire автоматически.
- Условный historical cohort явно отличается от strict и prospective; поздние source clocks не backdate-ятся. Нет утечки будущих результатов, duplicate maps или серии между splits.
- Fixed policy проверена на untouched temporal test с baseline, Brier/log loss/calibration, coverage, N карт/серий и зарегистрированными заранее порогами. Fitted calibrator не обязателен; отсутствие gate даёт unavailable/null.
- Новый выбор игрока создаёт новую ревизию/новый прогноз; предыдущий input/features/model/source snapshot остаётся неизменным. Несовпадение будущего фактического состава не удаляет старый forecast из audit.
- Только approved active artifact выдаёт числовую оценку с подписью об ожидаемых составах и типе проверки. E0/E1/synthetic никогда не активируются автоматически.
- **Обязательный S3-07/V1-journal:** каждый выданный forecast сохранён до ответа пользователю с immutable input/features/model/source и server issued_at. Target/real-forecast purpose фиксируются до выдачи. Таблица, фильтры period/version/status, counts расчётов и уникальных карт, verified-result linking и явное обновление результатов работают с owner auth/CSRF.
- Основная prospective статистика выбирает один forecast на actual canonical map по `last_successful_pre_start_v1` (TECHNICAL_SPEC §0.9); и created_at, и issued_at строго до actual start, cutoff допустим, модель была active на момент выдачи. Повторные расчёты/смена версии не раздувают headline N; старые версии остаются в истории. Нельзя привязать series ID к угаданной карте или задним числом переименовать what-if в реальный прогноз.
- Verified primary maps дают accuracy с явным знаменателем, Brier/log loss и простую reliability table. N=0→null; p=0.5 не имеет фаворита и отдельно исключён только из accuracy denominator. Pending/cancelled/unlinked/conflicting/failed и unavailable видимы, не считаются проигрышами и не скрываются; historical/research/what-if отдельно от live performance.
- Roster mismatch/unknown отмечен, но не удаляет корректно связанный pre-start forecast из общей сервисной статистики; matched-lineup conditional срез показан отдельно с N. Идемпотентный refresh не мутирует prediction snapshots; source corrections создают outcome/report revisions. Один map остаётся одним training example независимо от числа forecast runs. Graphs/advanced drilldowns/retraining automation не требуются для базового журнала.
- Сохранены existing analytics/schema/strict policy и пути добавления logistic, patch/role/cohesion, post-draft. Каждый новый feature profile имеет независимую проверку и versioned artifact; V1 не означает готовность полного MVP.

**Статус:** feature builder, inactive candidate, registry/runtime snapshots и базовый журнал реализованы и имеют отдельные проверки. Release test и подтверждение качества не выполнены, активной модели нет. Выпуск V1 и общий двухмодельный MVP не объявлены готовыми. Точный следующий срез — в [PROJECT_STATE](PROJECT_STATE.md).

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
