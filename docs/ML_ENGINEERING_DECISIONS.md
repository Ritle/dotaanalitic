# ML / Prediction Engine: конкретная реализация, воспроизводимость и сложные случаи

## 1. Две постановки, не одна

**Pre-map target:** `team_A_wins_this_map`, до драфта, только доступная в момент прогноза информация. **Post-draft:** та же метка, но при завершённом драфте и выбранных 10 героях (и корректном `draft_complete_at`). Target серии BO3/BO5 НЕ подменяет target карты.

Историческая модель знает о результате лишь как о label после завершения карты. Входные признаки восстанавливаются из `asOf(stage_cutoff)`; неизвестный pre-match ростер нельзя «узнать» из post-game API. Для offline experiments всегда отмечать `availability_policy: truly_pre_known | conditional_lineup_reconstructed` и обучать/evaluate результаты по отдельным режимам.

## 2. Предлагаемый ML baseline, без переусложнения

1. **Baseline-0:** constant prior (только для офлайнового сравнения, НЕ выдавать как пользовательский прогноз).
2. **Baseline-1:** хронологический opponent-adjusted Elo/Glicko-подобная оценка по игрокам/составам; без необоснованного наследования рейтинга организации при смене пятёрки.
3. **Baseline-2:** `sklearn.pipeline.Pipeline(SimpleImputer, StandardScaler, LogisticRegression)`; отдельная модель до драфта.
4. **Post-draft:** тот же набор pre-map признаков + patch-aware player-hero/pairs/counters, verified Radiant/Dire and draft order if known. Pre-score как признак разрешён только если он получен **out-of-fold / walk-forward** на training maps (иначе stacking leakage).
5. Калибровка Platt/sigmoid на **независимом по времени** calibration блоке (не на тех же значениях train). При небольшом количестве карт на патче избегать чрезмерной дробной сегментации; фиксировать правило abstain.
6. `CatBoost` — отдельный experiment candidate P1 только при улучшении на held-out temporal evaluation и наличии жизнеспособного deployment adapter.

**Почему Python для fit и TS для predict:** scikit-learn даёт зрелые алгоритмы и метрики, а inference базовой линейной модели состоит из детерминированного преобразования числовых признаков + sigmoid и легко выполняется в Node. Это снижает потребление RAM на VPS. Но реализовать JS port без совпадения результатов на golden vectors **нельзя**.

## 3. Контракт frozen dataset и pipeline

```text
verified pro maps
    -> stage-specific point-in-time feature builder (identical training/inference semantics)
    -> frozen dataset manifest (map ids, cutoffs, roster policy, source/data/schema revisions)
    -> training / calibration / untouched holdout (chronological, whole series grouped)
    -> sklearn fit + explicit feature order/preprocess params + calibration
    -> candidate model artifact (JSON + SHA256 + training run id)
    -> offline evaluator (Brier, LogLoss, calibration, acc, coverage, strata)
    -> manual gate approval -> atomic registry promotion -> Node inference
    -> immutable prediction run -> verified real outcome -> prospective monitoring
```

- Training examples **1 row per map/stage per dataset version**, даже если пользователь сохранил 50 прогнозов на эту карту.
- `dataset fingerprint` включает ordered map ids, stage/cutoff, revisions, input feature values/unknown masks, labels, preprocessing policy and code SHA. Исправление label создаёт **новую версию** датасета.
- Разделение **по времени и серии**: карта одной BO3 не должна попасть одновременно в train и test; добавить rolling-origin, holdout с периода после train+calibration. Настройка параметров — на внутренних temporal folds, окончательный holdout тестируется ограниченно и журналируется.
- Leakage в `Elo`: каждый матч обновляет рейтинг **после того, как pre-map features были вычислены**, независимо от порядка импорта. Shared feature builder при inference не обращается к итоговым статистикам карты.
- Data split для `patch cold start`: проверка на первом периоде нового патча, по игрокам с заменами, турнирам и малому `n_eff`.

## 4. Явный формат артефакта baseline

```json
{
  "format": "linear-probability-v1",
  "stage": "pre_map",
  "featureSchemaVersion": "pre_map_v1",
  "orderedFeatures": ["team_strength_delta", "roster_pair_n_eff_delta"],
  "preprocessing": {
    "imputer": [0, 0],
    "mean": [0.1, 2.5],
    "scale": [0.8, 1.4]
  },
  "linear": {"coefficients": [0.3, 0.2], "intercept": 0.1},
  "calibration": {"kind": "sigmoid_logit", "slope": 1, "intercept": 0},
  "trainingDatasetSha256": "<sha256>",
  "modelArtifactSha256": "<sha256-of-canonical-serialized-artifact>"
}
```

Это **пример формата** и фиктивных чисел для разработчика, а не реальные коэффициенты модели. Нужно документировать точную формулу `logit`, знак и область действия калибратора. `modelArtifactSha256` не должен включаться в те же байты, которые он хэширует: canonical content hash рассчитывается без самого поля/прикладывается в отдельном manifest. Инференс TS проверяет список признаков, порядок, версии и хэш; unknown не означает числовой 0, имputation+missing-indicator из training pipeline применяются одинаково. Не исполнять Python pickle/joblib из произвольных пользовательских файлов.

**Parity gate:** фиксированный набор N>=100 разнообразных frozen feature vectors, Python `predict_proba` vs TS inference max absolute error < `1e-7` (или заранее обоснованная tolerance с тестом), включая null/NaN/inf запреты, экстремальные logits, swapped Team A/B. Нарушение — блок публикации артефакта.

## 5. Model registry, gating, rollback

Status machine:

```text
created -> trained -> evaluated -> approved -> active -> retired
                          |            |
                          v            v
                        rejected     rollback -> previous active
```

Только одна активная версия на `prediction_stage` + `feature_schema_version` в согласованной конфигурации; транзакция promotion с compare-and-swap на прежний champion, advisory/row lock + activation event. Actual finished forecasts не редактируются. В P0 активация только явным CLI/manual; P1 допускает расписание retrain, но auto-promotion остаётся **OFF** без явного opt-in.

Не публиковать кандидата, если он не превосходит baseline по заранее определённым и зарегистрированным правилам: минимальное число карт/патчевое покрытие, Brier, Log Loss, недопустимая деградация на составе со заменой и на патчевом cold start, reliability bins, ошибках. Точные численные пороги — предмет walk-forward исследования, **не выдумываются заранее как гарантии**. Показывать предупреждение для недостаточного контекста/невалидного патча, при критическом gate -> `unavailable`.

## 6. Explainability без ложной причинности

У линейной модели можно показать вклады групп признаков (team/player/roster/patch/map) в logit и общую разницу вероятностей; в проценты их нельзя аддитивно складывать как причинные «вклады». Разница post vs pre при разных cutoffs не означает, что драфт *причинил* +7 п.п. Любой explain report содержит версию модели и feature policy. SHAP (будущий CatBoost) только если доказана дополнительная ценность и контролируется скорость.

## 7. Тестовый протокол

| Проблема | Проверка |
|---|---|
| Future leak | Добавление результата будущей карты не меняет прошлый feature vector |
| Roster hindsight | Состав из end-game record без pre-known evidence не проходит честный pre-map backtest |
| Team rename | При смене тега сила конкретного игрока переносится, сила организации не становится силой пятёрки |
| Series leak | Карты BO3 попадают только в один temporal fold |
| Duplicate outcome | 100 сохранённых prediction_runs = 1 map/stage training row |
| Patch shift | Первый месяц нового патча тестируется отдельной выборкой и получает availability warning |
| Small sample | При n_raw=0 показатель null; `n_eff` влияет на shrinkage/abstain |
| Artifact corruption | SHA mismatch и feature schema mismatch -> reject, не fallback 50/50 |
| Failed promotion | Champion остаётся активен при сбое SQL/transient failure |
| Python/TS parity | Golden vector probabilities отличаются не выше порога |

## Официальные руководства

- https://scikit-learn.org/stable/modules/calibration.html
- https://scikit-learn.org/stable/modules/cross_validation.html#time-series-split
- https://scikit-learn.org/stable/modules/model_evaluation.html
- https://catboost.ai/docs/en/features/categorical-features
