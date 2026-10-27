# Матрица трассировки нюансов → приоритет → реализация

Этот файл отвечает на вопрос: «Все ли предложенные улучшения попали в план?» Приоритет именно **проектный**, а номер задачи — стадия разработки.

| Нюанс | Приоритет | Архитектурное решение | Задачи Codex |
|---|---|---|---|
| Сила соперников / расписание сложных оппонентов | P0 | Elo по времени карты, не raw WR; opponent rating as-of | S1-05, S3-02/03 |
| Статистика команды ≠ сменяющаяся пятёрка | P0 | team ID ≠ exact lineup; pair maps across orgs | S0-05, S1-03, S3-02 |
| Равноценная личная замена может снижать synergy | P0 | exact 5, пары, роли, churn; нет fixed penalty | S1-03, S3-03 |
| Профессиональные роли и перестановки игроков | P0 | датированные role observations с source/confidence | S0-05, S1-04 |
| Историческая актуальность патча / reworks | P0 | patch registry, weights, cold start, n_eff | S1-07, S3-04 |
| Радиант / Дайр отдельно от Team A/B | P0 | `radiant_slot`, неизвестная сторона NULL | S0-06, S2-01 |
| Победитель карты != победитель серии / формат BO | P0 хранение, P2 прогноз | `series`, map number, score before, group-aware validation | S0-04, S3-01, S3-09/S5-05 |
| First-pick и правила драфта зависят от патча | P0 контракт, P1 order-based фичи | first-pick field и patch-order version; no side inference | S0-06, S2-05 |
| Уровень турнира, LAN/online, стадия | P1 | nullable context + source; offline ablation instead of fixed multipliers | S0-04, S5-02 |
| Неравная значимость малых выборок | P0 | shrinkage, sampleSize, effective n, prior documented | S1-06, S3-05 |
| Достоверность прогноза vs вероятность победы | P0 | model gate, coverage/quality separately, unavailable fallback | S3-05 |
| Сравнение pre-match / post-draft | P0 две модели, P1 детальный delta UI | independent calibrated models, compatible snapshots | S3-03/04, S3-08 |
| Исторический backtest без утечек | P0 | known_at vs event_at vs fetched_at, temporal series folds | S0-04, S3-01/02 |
| Полнота provider API и ошибки данных | P0 | statuses/nullable/provenance/conflict | S0-01/02 |
| Алиасы и несколько Steam-аккаунтов игрока | P0 | canonical player + verified links, never nickname merges | S0-05 |
| Дубликаты и разные источники одного матча | P0 | canonical `match_id`, source snapshots, field conflicts | S0-02 |
| Смена схемы OpenDota/STRATZ | P0 | adapter version + contract validation / test fixtures | S0-01/02 |
| Доступность отдельных героев на турнире/патче | P0 | evidence-backed dated hero rules, unknown != allow/deny | S0-06, S2-02 |
| Стилистическая сила драфта (контроль/пуш/tempo) | P2 | versioned features + ablation; separate from raw rates | S2-06, S5-04 |
| Сравнение сценариев с заменами и сторонами | P1 | branch parentScenarioId, independent snapshots | S5-01 |
| Подтверждение состава перед прогнозом | P0 | manually confirmed lineup, source/role/coverage | S1-03, S2-01 |
| Выбор временного диапазона анализа | P0 | cutoff, patch, temporal filter contract | S1-02, S2-04 |
| Сохранить прогноз до матча и фактический исход | P0 immutable forecast, P1 outcome link | `prediction_runs` + `prediction_outcomes` | S3-06, S3-07 |
| Model Performance | P1 | scoring по историческим настоящим outcomes | S3-07 |
| Предсказание BO3/BO5 / между картами | P2 | independent target/scores/validation | S3-09, S5-05 |

**Решение по MVP:** все P0 задачи блокируют готовность прогнозной части; P1 и P2 **не блокируют** персональную первую версию. Nullable поля в миграции — подготовка без premature feature implementation. Дополнительный контракт: `docs/POINT_IN_TIME_AND_MATCH_CONTEXT.md`, `docs/IDENTITY_AND_DATA_QUALITY.md`, `docs/MODEL_EVALUATION_AND_SCENARIOS.md`.

## Дополнение v4 — непрерывное улучшение и обратная связь

| Нюанс | Приоритет | Архитектурное решение | Задачи Codex |
|---|---|---|---|
| Новый завершённый pro-матч становится кандидатом в обучающую выборку | P0 | canonical verified `matches` outcome, eligible map id, `known_at`; не из пользовательского прогноза | S0-07, S3-00 |
| Один матч = один обучающий пример на stage/dataset | P0 | UNIQUE `(dataset_version_id,match_id)` + separate `prediction_runs`/`prediction_outcomes` | S0-07, S3-00 |
| Заморозка датасета и воспроизводимость | P0 | immutable training_dataset_versions/maps, features/label/code/patch revisions, split fingerprint | S0-07, S3-00/01 |
| Кандидат и безопасная публикация | P0 | training run + external SHA-256 artifact, independent evaluation, quality gate, atomic active switch + audit | S3-03/04/05 |
| Новая модель против текущей / откат | P0 контракт, P1 автоматизация | model_evaluation_runs, model_activation_events, champion/challenger | S3-05, S5-06 |
| Связь реального исхода с прошлым прогнозом | P1 | `prediction_outcomes`, explicit prospective eligibility, monitoring | S3-07 |
| Автоматическое пакетное переобучение | P1 | durable PostgreSQL jobs, threshold/patch triggers, no per-request training | S5-06 |
| Автоматическая публикация новых версий | P1, opt-in | disabled by default, holdout gates, CAS+rollback, audit | S5-06 |
| Пользовательский выбор фаворита | P2 | отдельные guess/feedback, НЕ ground truth | вне MVP |

См. `docs/CONTINUOUS_LEARNING_PIPELINE.md` + миграцию `005_training_pipeline.sql`.

## v9 — матрица обнаруженных live-data нюансов

| Нюанс | Priority | Решение | Задачи |
|---|---|---|---|
| 0/11/12 pick events, хотя 10 финальных героев | P0 | Raw `picks_bans`/final heroes/validated timeline отдельно; не чинить удалением picks | S0-10, S0-02, QA-04 |
| 24% карт без двух IDs организаций и `series_id > 0` в выборке 50 | P0 | Nullable historical team/series; независимые quality facets, не исключать hero/player stats | S0-10, S1-08 |
| Nonempty draft_actions не значит полный draft | P0 | `draft_picks_exact`, `draft_heroes_match`, `draft_teams_match` + anomalies | S0-08, QA-04 |
| Хронология зависит от патча/режима | P0 safe default, P1 полноценный order validator | `draft_order_valid=null` без patch/mode rule evidence | S0-06, S0-10, S2-02 |
| Hero-only post-draft без полного timeline | P0 | Model-specific eligibility; финальные 10 героев + известность на cutoff | S3-00, S3-04 |
| Коррекция provider source после импорта | P0 | Append-only source observations и versioned assessments, immutable frozen datasets | S0-10, S3-00 |

Подробно: [DRAFT_DATA_INTEGRITY.md](DRAFT_DATA_INTEGRITY.md) и forward-only `006_draft_data_quality.sql`.
