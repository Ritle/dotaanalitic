# Prediction Engine: технический контракт

## Стадии

- `pre_match`: вероятность победы **Team A в одной карте**, только известные до драфта данные о командах, подтверждённой/предполагаемой пятёрке, форме, Elo, патче и стороне, если она известна.
- `post_draft`: отдельная модель на полной 5v5 карте с **10 различными героями**, player-on-hero метриками, связками союзников, противостояниями и pre-match score. Для 0..9 героев доступен descriptive report без probability.

## Pipeline

```text
Historic pro maps (point in time, before T)
  -> verified winner labels separately from frozen as-of feature data
  -> versioned frozen dataset manifest + match-level fingerprints
  -> feature builder at cutoff T
  -> temporal split (train | calibration | test), grouped by series
  -> baseline Elo / pre-match logistic / post-draft logistic
  -> calibration and metrics
  -> model artifact + feature schema + quality gate
  -> candidate registry + independent gate -> approved promotion (manual by default)
  -> API inference using SAME feature builder
  -> immutable prediction snapshot
```

## Leakage guard

For predicted map at `T`, all inputs except the known current **draft heroes and players** come from records with `started_at < T`. Never use actual map results, kills, damage, gold, duration or global stats recomputed after T. Current series games should never leak through test/train group split. Out-of-fold `pre_match` scores must be used when building post-draft training features. `cutoff_at` must be stored.

## Features (proposal; do not create unsupported features)

Pre-match: rolling Elo difference, opponent-strength-adjusted team form, exact-lineup map count, active-roster freshness, patch recency, known Radiant side, missingness indicators. Post-draft: pre score/logit computed without leakage, lineup role assignments, player×hero familiarity, hero-meta rates on pro-only before T, ally pair strength and directed 5×5 matchups with sample sizes, missingness.

## Patch-awareness (обязательный feature contract)

Полный контракт в `docs/PATCH_AWARE_ANALYTICS.md`. Нельзя смешивать `patch_id` как чистый UI-фильтр со **взвешенной** признаковой оценкой для модели. В pre-match приоритет у свежей силы текущего состава и игрока; в post-draft — у недавних hero-specific, pair и matchup данных текущего/близких патчей. Старые матчи при переходе через крупные изменения получают гораздо меньшее влияние; подтверждённый rework может обнулить переносимость прежнего hero-признака.

Обязательные параметры модели: `patch_registry_revision`, `weight_policy_version`, `target_patch_id`, patch-adjusted features, `n_raw`, `n_eff`, coverage. При ретро-бэктесте доступна только история патчей, опубликованная до cutoff. Вероятности на новом патче допустимы только после проверки quality gate с учётом drift; на холодном старте показывать предупреждения и при необходимости `unavailable`.

Базовые сравнительные эксперименты: без взвешивания, экспоненциальное затухание по времени, затухание по времени + patch transition + подтверждённые изменения героев. Измерять Brier/log loss/ECE на одинаковом хронологическом holdout, отдельно сразу после крупных обновлений; не выбирать параметры на holdout.

## Evaluation

1. Baseline: Elo (and/or constant class-prior comparator where relevant).
2. Train / calibration / holdout test chronological, prevent maps from same known series crossing folds.
3. Holdout metrics: N, Brier, log loss, reliability/calibration (ECE + plot), accuracy secondary. Compare both stages on **same** post-draft subset.
4. Verify swap symmetry `p(A,B) ≈ 1-p(B,A)` with known side inversion; otherwise inspect feature encoding.
5. Document data freshness, patch drift, missing identities, selection bias from incomplete historic data.
6. Candidate gate (not scientifically guaranteed): holdout n >= 300 per stage; calibrated Brier and log loss no worse than baseline on comparable maps; ECE limit set in config and documented. If conditions unmet, remain inactive.

## UX and storage

Only `prediction_model_versions.is_active` + green quality gate can emit probability. On failure `status=unavailable` and `teamAWinProbability=null`. UI shows confidence/quality caveats, sample volume, date and model version. Save `input_snapshot`, `feature_snapshot`, `cutoff_at`, data revision and warnings in `prediction_runs`. `delta_pp = (p_post - p_pre)*100` only if both models successfully predicted the same scenario revision/cutoff/lineup; otherwise `null`.

## No betting recommendations

These are model estimates, not guarantees or a signal to wager. Do not optimize for or present ROI of bets.

## Roster-aware features, substitutions, team integrity

Обязателен `docs/ROSTER_CONTINUITY.md`. Предматчевая модель должна учитывать не только team_id, но и **конкретную пятёрку**, её индивидуальную историю *во всех организациях*, точные общие карты, 10 pairwise co-play статистик, недавний churn, изменения ролей и разницу baseline→candidate при ручной замене. Старый organization Elo ослаблять или рекомбинировать при массовой смене состава — параметры только через временной backtest.

Post-draft модель наследует roster features и добавляет `player × hero`, патч-релевантные hero synergy/matchups. Никакого константного stand-in penalty: сравнить абляции `team Elo`, `+ individual`, `+ cohesion/churn` на одном временном holdout, включая трансферные окна. Одинаковая дата T, известность составов as-of, отсутствие будущих трансферов, карт и ролей. История совместной игры сохраняется при переходе **обоих** игроков в другой team_id. Если known IDs/expected lineup неполны — coverage и warning; модель может вернуться `unavailable`. Сравнивать изменение шансов при замене можно лишь между одинаковыми по условиям снимками и активной моделью; не называть эффект причинным.

## P0/P1/P2 требования после ревизии плана v3

**[P0]** Модель до драфта имеет только pre-known признаки: strength-of-schedule adjusted Elo, канонических игроков, роли, свежую точную пятёрку и пары, патч, сторону (если уже известна) и missingness. После драфта — дополнительно 10 hero IDs, назначения на роли, patch-weighted игрок×герой, союзные unordered пары, directed opponents. Не считать first pick известным лишь потому, что он есть в послематчевом API. Разделение `started_at`, `known_at`, `fetched_at` и series-aware splits — обязательны. Связи account могут объединяться лишь после verified identity.

**[P0]** Проверять raw vs smoothed stats, `n_raw/n_eff`, prior/shrinkage (fit только на train/validation), opponent-adjustment, role changes, unknown patch/draft order. Target одной **карты**. Предматчевый прогноз не получает пики текущей карты и будущий счёт серии. Для одинаковой holdout-выборки проверить pre/post Brier/LogLoss/ECE, Elo baseline и эффект добавленных roster/patch/draft фичей; вернуть unavailable при неуспехе gate.

**[P1]** `prediction_outcomes` связывает frozen prediction с реальным исходом; Model Performance, What-if и сравнение pre/post реализуются как отдельные задачи. LAN/online, stage/tier и точный pick/ban order — только после проверки availability и выигрыша по качеству, не через произвольные веса.

**[P2]** Модель победы BO1/BO2/BO3/BO5 и between-maps требует **другой** target/validation, BO2 может не иметь победителя. Стратегические признаки (control/tempo/scaling) — только с версионированием и офлайн проверкой.

Дополнительные тестовые протоколы: `docs/MODEL_EVALUATION_AND_SCENARIOS.md` и `docs/POINT_IN_TIME_AND_MATCH_CONTEXT.md`.

## Verified outcome feedback / continual improvement (v4)

Нормативный pipeline: `docs/CONTINUOUS_LEARNING_PIPELINE.md`. После матча импортируем канонический pro-исход; **это новая метка для одного матча**, не подтверждение правоты прошлой вероятности. Training dataset строится из verified `matches`, а не из `prediction_runs`/пользовательских guesses. При наличии 20 прогнозов одной карты тренировочная выборка по-прежнему имеет **один** пример для данного map id/stage. Прогнозы связаны с `prediction_outcomes` исключительно для проспективной оценки и анализа качества.

`DatasetBuilder` (P0): строгий as-of, frozen feature vectors, independent later-observed target, immutable manifest + fingerprint, grouped chronological splits, separate train/calibration/validation/test, источник метки/корректировки. `TrainingOrchestrator` P0 запускается offline командой на выбранной версии датасета, сохраняет run/config/seed/artifact SHA-256, создаёт **inactive** candidate. `ModelEvaluator` проверяет отдельный holdout и сравнивает с baseline/champion; `ModelRegistry` активирует подходящую модель атомарно с audit event; rollback предусмотрен архитектурно. В P1 можно добавить scheduled batch retraining, сравнение с действующей моделью и *opt-in* автопубликацию (по умолчанию отключена). Ни одни модели не переобучаются на лету по HTTP-запросам.

Проверку долгосрочного качества проводить по verified **prospective** прогнозам, сделанным до фактического начала карты, отдельно от ретро-бэктеста; гипотетические сценарии/прогнозы после факта исключать из live-метрик. Сохранять разрезы по версии патча и фактической пятёрке; при невалидном domain shift блокировать новые вероятности (`unavailable`).

## v8 field catalog and feasibility

See [PREDICTION_DATA_SPEC.md](PREDICTION_DATA_SPEC.md) for data source matrix, P0 feature vector, strict as-of vs conditional lineup, dataset readiness and live API audit tool.
