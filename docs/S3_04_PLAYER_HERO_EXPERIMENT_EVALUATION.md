# S3-04 — оценка опыта игрока на герое

**Результат по заранее закреплённым критериям: negative.** Наблюдаемые метрики H2 лучше H1, но парный интервал неопределённости по log loss включает ноль. Подтверждённого преимущества нет. Остальные критерии качества и data floors выполнены. Это исследование на ранее раскрытом корпусе, не независимая release-проверка; рабочая V1 сохранена.

[Протокол](S3_04_PLAYER_HERO_EXPERIMENT_PLAN.md), [выборка](S3_04_PLAYER_HERO_EXPERIMENT_DATASET.md), [обученные варианты](S3_04_PLAYER_HERO_EXPERIMENT_FIT.md), [проверки и SHA](evidence/s3-04-player-hero-experiment-evaluation.json).

## Результат на общем наборе карт

186 из 223 карт, 86 известных серий; покрытие 83,41%. Непригодные 37 карт остались в ledger с причинами. Baseline-only: 0. Одна карта — одно наблюдение, не отдельные строки игроков и не победитель серии.

| Вариант | Log loss ↓ | Brier ↓ | Верно | ECE ↓ |
|---|---:|---:|---:|---:|
| H0 | 0.635428 | 0.221918 | 120/186 (64.52%) | 0.090939 |
| H1_raw | 0.640259 | 0.224142 | 120/186 (64.52%) | 0.098995 |
| H1_cal | 0.634834 | 0.221644 | 120/186 (64.52%) | 0.089611 |
| H2_raw | 0.636333 | 0.222319 | 124/186 (66.67%) | 0.098869 |
| H2_cal | 0.631092 | 0.219959 | 124/186 (66.67%) | 0.085208 |

Основной контраст **H2_cal − H1_cal**: Δlog loss **−0,00374137**,95% series-bootstrap CI **[−0,00991893; +0,00209662]**. Для положительного исследовательского сигнала верхняя граница должна быть ниже0; это условие не выполнено. Остальные зафиксированные проверки прошли: log loss H2_cal ниже H0, Brier не выше H0/H1_cal, ECE≤0,10, покрытие≥80%, необходимые map/series/class counts. Единственная причина отрицательного вывода — `NO_SIGNIFICANT_LOGLOSS_GAIN_OVER_H1`.

124 верных исхода против120 — наблюдаемое различие в 4 карты, а не обещание будущей точности 66,67%. Интервал exploratory: эти карты уже участвовали в предыдущем исследовании. Пороги, коэффициенты, температуры, выборка и модель для основного сравнения не менялись после результата. Raw-варианты показаны отдельно и не подменяют calibrated primary.

## Срезы и пропуски

Отчёт сохраняет provider, league, provider patch, canonical patch, месяц UTC, наличие нулевого hero-count и неизвестных героев в части истории. Provider patch не подставляется вместо canonical patch. Canonical patch/role/pre-start draft provenance остаются ограничениями исследования.

В позднем блоке 179 карт имеют хотя бы одного игрока без найденной практики на герое за 90 дней; 7 карт — без такого пропуска. Неизвестные герои в части предыдущей истории затрагивают 2 карты, остальные 184 — без этого флага. Малые срезы не используются для выбора победившего варианта или изменения gate. В отчёте видны обе true/false группы даже при пустом срезе; empty rates/metrics равныnull.

Все пять вариантов сравниваются на общем полном наборе пригодных карт. Если прогноз/калибратор отсутствует, вся известная серия исключается из common cohort, а полный denominator, baseline и доступные raw diagnostics сохраняются. На реальном run таких дополнительных исключений нет. Матрица availableMetricsDiagnosticOnly не используется для gate.

## Регистрация и воспроизведение

Run `.tools/s304-hero-eval-r1`; evaluator зарегистрирован **2026-11-13T19:05:39.638Z**, scoring начат **2026-11-13T19:06:08.638Z**. Report SHA: `b4d052346ea840c557029da0bc0cfd4a3f6bc17b6f19a32b6418778a1982adc3`. Первый отрицательный результат сохранён неизменно.

Добавлены `tools/research/player-hero-evaluate.mjs`, `player_hero_evaluate.py`, Node/Python tests. Ранее зафиксированные TS inference, coefficients/calibrators и numerical metrics/bootstrap helpers переиспользованы с SHA-проверкой. Переименование H↔M внутри bootstrap — явный адаптер названий; математика и старые файлы не изменялись.

До scoring выполнен полный replay dataset; проверены fit evidence/manifest/artifact/result, source SHA, code, environment, Python/TS parity и policy. Ни fitting, ни calibration fitting не вызываются. Входы рассчитываются только для development_test; ранние карты не оцениваются. Verify повторяет fixed inference, metrics, bootstrap и сравнивает input/report/result. Нет HTTP к поставщикам, записи в рабочую БД, публикации новых вероятностей или активации.

Метрики: stable logaddexp без clipping, accuracy выбирает A при p≥0,5; 10 равных reliability bins, последний включает1. Bootstrap: 2000 общих парных выборок целых серий, PCG64 seed 42, веса по числу карт, percentile95 linear. Draw SHA: `fcd2150da8bec20fcb6e10407b8f515ca5de387e0244912d02ed67bbb12e569e`.

```powershell
node tools/research/player-hero-evaluate.mjs verify .tools/s304-hero-eval-r1
.venv/Scripts/python.exe -m pytest tests/research/test_player_hero_evaluate.py -q
node --test tests/node/player-hero-evaluate.test.mjs
```

## Проверки

21 Python + 5 Node tests PASS: независимые sklearn metrics, empty bins/null, крайние logits, unequal whole-series weighting, воспроизводимость и порядок, неизменность inputs, positive/negative/insufficient outcomes, сохранение знаменателя/upstream failures, отсутствие raw fallback, unavailable calibration/whole-series closure, все срезы, запрет подмены label/policy/series/SHA/feature inputs. Фикстуры синтетические и не используются в настоящем scoring.

Независимый oracle: 1860 сверок logits/probabilities из фиксированных коэффициентов, 32 сверки метрик и bootstrap limits, 2000 явных resamples с целыми сериями и тем же draw SHA, 7 реестров срезов, 186 labels и полный denominator 223 PASS. Он не импортирует evaluator helpers для численных расчётов. Старые критерии, модели и исходные артефакты сохранены.

Frozen offline install, typecheck, 978 пакетных tests и build PASS. Final post-build replay с недоступным DATABASE_URL PASS. Корректная копия воспроизводится; подмена CI/negative decision положительным результатом даже с пересчитанными SHA report/result отвергается. Повторный run не перезаписывает первый отчёт. 57 SQL и historical checksums, docs links/whitespace/git diff --check PASS. API/Web200, private401 без сессии, прежние active model ID/report SHA/model_eligible и compiled orchestration SHA. Прежние Zod/chunk-size build warnings сохранены. Browser/PG integration suites отдельно не запускались: UI/API/SQL не менялись.

**Следующая задача: S3-04/player-hero-error-audit — разобрать, на каких фиксированных картах признак практики помог или ухудшил прогноз относительно H1, проверить влияние нулевой и неполной истории и сформулировать следующий шаг; без изменения коэффициентов, порогов и активации. Рекомендуемая модель: GPT-6 Astra · High.**
