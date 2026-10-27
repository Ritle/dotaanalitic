# Continuous Learning & Outcome Feedback — нормативный архитектурный контракт (v4)

**Статус:** требования/схема (P0) и будущая автоматизация (P1), **не реализованный ML pipeline**. Применяется к персональному single-owner сервису. Первая цель: предсказание победителя **одной профессиональной карты** двумя моделями (`pre_match`, `post_draft`). Не смешивать с оценками победителя серии, любительскими играми или ставками.

## 1. Главное правило: модель обучается на результатах карт, а НЕ на собственных прогнозах

- **Ground truth (label)** — проверенный результат завершённой **pro-карты** из канонической `matches` с `is_pro IS TRUE`, `radiant_win IS NOT NULL`, валидными сторонами/участниками и подтверждённым `match_id`. Признак и метка сохраняются независимо. `team_a_won` вычисляется по явно установленному соответствию Team A ↔ Radiant/Dire; при неизвестном соответствии пример исключается.
- `prediction_runs` — неизменяемые *оценки*, созданные до карты; это **не метки, не отдельные тренировочные матчи и не способ увеличить выборку**. 10 прогнозов одной карты не превращаются в 10 обучающих строк.
- `prediction_outcomes` связывает *фактический исход* с неизменяемым прогнозом для мониторинга и сравнения пользователей/версий. Такая привязка не нужна для включения любого про-матча в историческую обучающую выборку: она формируется **из канонических карт**.
- Ручной сценарий What-if, неподтверждённая карта, публичная рейтинговая игра, неизвестная сторона и пользовательская оценка победителя не могут стать ground truth. Пользовательские оценки при появлении функции сохраняются отдельно и используются **только для сравнительной статистики**, без влияния на обучение по умолчанию.
- Исправленный источник матчей/результат может породить **новую версию датасета**; не исправлять задним числом замороженную обучающую выборку и прошлые прогнозы. Сохранять provenance и причину исправления.

## 2. Путь данных

```text
OpenDota/STRATZ → validated normalized pro maps → canonical matches/match_players
                                           │
                                           ├─ OutcomeVerifier → verified map result / source evidence
                                           │                    └─ PredictionOutcomeLinker → prediction_outcomes → Monitoring (P1)
                                           │
                                           └─ DatasetBuilder (as_of each map start; only prior knowledge)
                                                 └─ versioned frozen DatasetManifest + examples
                                                        ├─ historical chronological train/calibrate/validate/test
                                                        └─ new eligible maps (one per match_id/stage)
                                                                ↓
                                               TrainingOrchestrator (CLI now; queue/schedule P1)
                                                  → candidate artifact (not active)
                                                  → Evaluator / Calibrator / baseline comparison
                                                  → QualityGate & drift checks (including patch/roster)
                                                  → Registry → approved activation/rollback
                                                                ↓
                                               PredictionService → immutable prediction_runs
```

**Никакой обучающей работы в HTTP request.** Data Collector может автоматически добавлять новые **проверенные карты** в пул доступных кандидатов (P0), но не запускать произвольное обучение на каждую карту. Полная автоматизация расписания и переключения версий — P1.

## 3. P0: архитектурные контракты и сущности

Миграция `005_training_pipeline.sql` добавляет независимые от UI слои:

1. `training_dataset_versions`: fingerprint/версии признаков, правил формирования target, patch registry, правила разбиения, provenance/cutoff, состояние `building → frozen` и manifest. Замороженная версия не редактируется.
2. `training_dataset_maps`: **одна строка на `dataset_version_id × match_id`**, сторона Team A/B, `cutoff_at`, frozen input features/hash, подтверждённая метка, время подтверждения и split. Нет повторов за счёт нескольких прогнозов пользователя. Историческая фича использует только факты, **известные на момент T**; метка появляется **после** карты и никогда не входит в features.
3. `model_training_runs`: асинхронные offline job runs с versioned dataset, algorithm/config/seed, status, code revision, ошибками и идентификатором модели. **Наличие записи не означает обученную модель.**
4. `model_evaluation_runs`: метрики на *независимой временной* выборке (Brier, log loss, ECE, N, patch/stand-in slices), gate policy/version, baseline, результат проверки и статус. Калибровка обучается отдельно и не использует holdout.
5. `model_activation_events`: журнал переходов active candidate / rollback, gate evidence, предыдущей модели; активна не более одной версии на stage (существующий `uq_active_model_per_stage`). Внешний артефакт привязан к SHA-256 и versioned schema, не произвольный URL.
6. `prediction_model_versions.training_run_id` связывает опубликованный артефакт с попыткой обучения. `prediction_runs` и `prediction_outcomes` сохраняются без изменения; строгая неизменяемость терминальных predictions уже обеспечена миграцией 004.

Разместить интерфейсы внутри одного backend/worker и `packages/prediction`:

```ts
interface OutcomeVerifier { verifyProMap(matchId: string): Promise<VerifiedMapOutcome | Unavailable>; }
interface DatasetBuilder { buildFrozen(stage: 'pre_match' | 'post_draft', asOf: string, policyVersion: string): Promise<DatasetVersionId>; }
interface TrainingOrchestrator { enqueue(datasetId: string, configVersion: string): Promise<TrainingRunId>; }
interface ModelEvaluator { evaluate(candidateId: string, holdoutId: string, gatePolicy: string): Promise<EvaluationId>; }
interface ModelRegistry { promote(candidateId: string, evaluationId: string, expectedCurrentId: string | null): Promise<void>; rollback(stage: string, toVersionId: string, reason: string): Promise<void>; }
```

Это **контракт**, а не требование создать пустые интерфейсы вместо функционального MVP.

## 4. Point-in-time, history, duplicates

Для прогнозируемой карты с началом `T`: `feature_cutoff_at = T`; для каждой исторической карты `historical.started_at < T`, каждое использованное внешнее сведение должно быть доступно на `T` согласно `known_at`/верифицированной политике; `fetched_at` сам по себе не доказывает существование факта до T. Признаки фактической карты (`radiant_win`, KDA, duration, gold и т.п.) не должны попасть в input. Допустимы известные на соответствующей стадии состав/роль, для `post_draft` — 10 hero picks и законно известные side/order.

В обучении:
- `training_dataset_maps` уникальна по `(dataset_version_id, match_id)`; то же самое матч в другом датасете допустим как новая frozen version, но **не доп. наблюдение внутри версии**.
- Split по времени, серии **целиком в одном split**. Модель `post_draft` получает только out-of-fold pre-match score на train, а не in-sample score.
- Предматчевый/последрафтовый датасеты относятся к разным stages; постдрафтовая выборка обычно уже (не все карты содержат полный драфт). Метрики двух этапов сравниваются на одинаковом subset карт.
- Training, calibration, tuning validation и финальный holdout не пересекаются. Новый prospective блок можно выделять по времени; не переиспользовать многократно holdout для выбора гиперпараметров. В новой версии обновить даты окон и fingerprints.
- Новые pro-матчи становятся eligible только после проверки полноты и корректности winner/team-side mapping. Исправления result отменяют eligible label в новом датасете, а не незаметно исправляют прежний.

## 5. Lifecycle модели

| Шаг | Действие | Порог реализации |
|---|---|---|
| Пришла новая карта | Верифицировать про-статус/исход, дедуплицировать, фиксировать источник | **P0** |
| Сформировать dataset vN | As-of features для всех eligible карт, labels только после карты, freeze manifest/hash | **P0** |
| Ручной offline train/evaluate | Версионировать код и параметры, model artifact, baseline, temporal tests | **P0** (этап S3) |
| Данные для прогноза | Only `active` + evaluated candidate; immutable prediction snapshot | **P0** |
| Сравнить прогноз с результатом | Verified map → outcome link (отдельно) → performance по model/patch | **P1** |
| Регулярно инициировать переобучение | Триггер по N новым eligible картам и/или patch changes, без конкурентных запусков | **P1** |
| Challenger vs champion | Проверить Brier/Log Loss/ECE, coverage, patch- and roster-slices, drift; нельзя использовать training для финального выбора | **P1** |
| Автопубликация | **OFF по умолчанию**; возможна только как явная настройка и после независимых gate, audit+rollback | **P1** |
| User guesses / crowd wisdom | Отдельная опциональная аналитика, не ground truth, не в MVP | **P2 / future** |

**Promotion safety:** новая модель сначала `candidate`. Failed/tiny/out-of-domain evaluation → оставить действующую. Активация новой версии в *одной PostgreSQL транзакции*, `SELECT ... FOR UPDATE`/advisory lock, проверка expected current model (CAS), stage совпадает с evaluated stage, публикация quality gate и SHA256 артефакта; `previous_model_id` для rollback. Никакой активной версии с отсутствующим/повреждённым артефактом. При ошибке загрузки artifact — прежняя активная версия или `unavailable`, **без** фиктивной вероятности.

## 6. Наблюдение за прогрессом

- Метрики на **проспективных** прогнозах, сделанных до карты: Brier/Log Loss, ECE, N, разбивки pre/post, по патчам, составам/stand-in, missingness и новизне патча. Отдельно офлайн backtest — не считать тренировочные предсказания live качеством.
- Сохранять `prediction_run_id`, model version, `cutoff_at`, `created_at`, `input_hash`, actual `match_id`, verification timestamp, source и label; привязывать только при строго доказанном совпадении карты, сторон, состава/ревизии и времени **до начала** карты. Гипотетические сценарии исключать из проспективной статистики.
- Существующая `prediction_outcomes` может связывать и ретроспективные/what-if снимки; поэтому UI **должен явно фильтровать** `prediction_runs.created_at < matches.started_at` и `cutoff_at <= matches.started_at`, а также verified context match (A/B sides, players, patch). Одной даты недостаточно для объявления live-прогноза.
- Данные не передаются другим пользователям; продукт остаётся персональным с одним владельцем. Функция совместного обучения между разными пользователями **вне области текущего проекта**.

## 7. P0 acceptance / regression tests

1. `prediction_runs` создаёт 20 прогнозов одной карты → новый датасет всё равно содержит **одну карту** на stage; оценки не являются labels.
2. `radiant_win` изменён на противоположный в fixture → features as-of T идентичны, меняется только label. `match` с неверной/неизвестной стороной не eligible.
3. Pre-match features не содержат текущий draft; post-draft features используют только законно известные heroes; future map или late-known datum не протекает в прошлое.
4. Серия BO3 не делится между train и holdout; maps counted as separate targets, but grouped split.
5. Заморозить dataset → попытка изменить headers/examples SQL-операциями отвергается триггером; исправление исхода порождает новую версию.
6. Training crash/retry не оставляет model active, job idempotent; stage-contradiction и artifact SHA mismatch отклоняют promotion.
7. Challenger не улучшил или holdout/patch sample слишком мал → champion остаётся active. Успешное переключение/rollback атомарно, audit event записан.
8. Fake What-if / прогноз создан после завершения карты не попадают в **prospective** performance; привязка исхода не меняет `prediction_runs`.
9. Новые verified карты добавляются в пул обучения; job не запускается на каждую карту и не заполняет sample dummy predictions.
10. Timestamp/patch/feature-policy/code/data revision/fingerprint сохраняются и позволяют пересобрать пример, отчёт и результаты backtest без обучения на будущих данных.

## 8. Непосредственный результат для Codex

- Миграцию 005 включить в S0-00 и схему до разработки импортера и training features.
- S0-07 [P0]: схема, источники labels, feature/label separation, freeze и идемпотентность. `S3-00 [P0]`: DatasetBuilder / offline CLI и тесты. `S3-01..06`: train/evaluate/registry с неизменяемыми manifests. `S3-07 [P1]`: link verified outcome и мониторинг live vs backtest. `S5-06 [P1]`: фоновое расписание и candidate promotion workflow.
- Все действия P1 не мешают простому хранению и использованию P0 датасетов.
