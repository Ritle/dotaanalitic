# S3-04 — обучение вариантов с опытом игрока на герое

По [зарегистрированному протоколу](S3_04_PLAYER_HERO_EXPERIMENT_PLAN.md) обучены два отдельных исследовательских варианта на [замороженной выборке](S3_04_PLAYER_HERO_EXPERIMENT_DATASET.md). Артефакты воспроизводятся точно; Python/TypeScript parity PASS. Поздний development-блок не оценивался. Это результат fitting, не проверка качества и не разрешение выпускать post-draft прогноз.

[Проверки, SHA и параметры](evidence/s3-04-player-hero-experiment-fit.json). Run `.tools/s304-hero-fit-r1`: manifest зарегистрирован **2026-11-13T18:46:31.620Z**, запуск **2026-11-13T18:47:23.865Z**. Artifact SHA: `9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b`.

## Результат обучения

| Вариант | Входы | C | Коэффициенты | Температура |
|---|---|---:|---|---:|
| H1 | Elo logit | 1 | 0,8180622966556597 | 0,7933639640518718 |
| H2 | Elo logit; pro-практика на герое | 1 | 0,7708530813119323; 0,1357780175911949 | 0,811023232354886 |

Оба optimizer и calibrator завершились; температуры внутри зарегистрированных границ. Положительный коэффициент практики — найденная связь в обучающих данных, не доказательство причинного эффекта или улучшения прогноза. H0 остаётся фиксированным sigmoid прежнего Elo logit и не обучается.

881 карта использована для коэффициентов, 306 — для выбора C, 284 — для температуры. Все1471 строки одинаковы для H1/H2; labels соединяются по `matchId`. L2/lbfgs, C[0.01,0.1,1], seed42, один поток, max_iter2000, tol1e-8; без intercept, class weights, scaling, imputation, augmentation или refit на train+validation. Выбор C — минимальный validation log loss, tie1e-12 в пользу меньшего C. Неудачная сходимость исключает кандидата. Изменять эти настройки по результату запуска нельзя.

`selected.json` сохраняет обе модели с выбранными коэффициентами **до** temperature fitting. Калибратор использует только calibration, bounds[0.25,4], xatol1e-8, maxiter1000; boundary/nonconvergence дают insufficient без скрытой подстановки. `artifact.json` связывает manifest, fit-input, dataset, labels и SHA selected. Повторный run не перезаписывает первый результат.

## Ограничение доступа к поздним данным

Node читает замороженные файлы для проверки SHA и формирования проекции. Python получает отдельный `fit-input.json` только с train/validation/calibration. Поздние186 карт отсутствуют в нём; поздние inputs/labels не извлекаются для обучения, выбора параметров, goldens или калибровки. Тест с getter, бросающим исключение при чтении late inputs/outcome, проходит. Дополнительные поля результата в feature DTO запрещены; времена label completion/verification отдельно проверены и не входят в матрицу.

Весь прежний корпус остаётся exposed/development. Исторические составы и герои реконструированы, доступность результатов условная; known_at не перенесён назад. Нулевые наблюдения на герое сохраняются, warnings о неполной истории не становятся новыми признаками. Работающая V1 и её реестр не менялись. Новые артефакты имеют `deployable:false`, `qualityGate:not_evaluated`; автоматической активации и нового API нет.

## Реализация и воспроизведение

Добавлены `tools/research/player_hero_fit.py`, `player-hero-fit.mjs`, `player-hero-inference.mts`; тесты `tests/research/test_player_hero_fit.py` и `tests/node/player-hero-fit.test.mjs`. Численные fit/selection/calibration helpers переиспользованы из прежнего SHA-проверенного `post_draft_fit.py`; старый код и артефакты не изменены.

Manifest фиксирует Python executable SHA, установленные пакеты и BLAS/threadpool metadata, Node, переменные числа потоков, source/implementation/TS compiler/compiled runtime SHA, lockfile и policy. scikit-learn1.8.0, NumPy2.3.5, SciPy1.17.0, joblib1.5.3, threadpoolctl3.6.0. Во время регистрации полностью воспроизведена выборка. Verify повторно обучает модели, проверяет `selected.json` и весь `artifact.json`, затем сравнивает Python goldens с TS и неизменяемый result. Изменение коэффициента нельзя скрыть простым пересчётом fingerprint или goldens.

```powershell
node tools/research/player-hero-fit.mjs verify .tools/s304-hero-fit-r1
.venv/Scripts/python.exe -m pytest tests/research/test_player_hero_fit.py -q
node --test tests/node/player-hero-fit.test.mjs
```

Для чистого запуска целевых тестов сначала скомпилировать `player-hero-inference.mts` в `.tools/s304-hero-fit-test-runtime` с strict/noUncheckedIndexedAccess/ES2022/NodeNext и один раз экспортировать synthetic goldens из Python-теста через `DOTA_PLAYER_HERO_PARITY_OUTPUT=.tools/s304-hero-fit-synthetic.json`. Экспорт использует `x`, повторные тесты выполняются без этой переменной. Фикстура syntheticOnly:true никогда не используется для реального CLI fit, который её отвергает.

## Проверки

19 Python и5 Node тестов PASS: детерминизм, train-only коэффициенты, независимость от calibration, выбор C/tie, invalid candidates, insufficient calibration, нули и предупреждения, временные границы/серии/duplicate labels, запрет late split и лишних feature fields, swapped A/B, extreme logits и подмена goldens.

Parity:262 набора для каждого H0/H1/H2,1570 численных сравнений; max error1.11e-16 при допуске1e-7. Обычные, swapped, zero practice, missing-history annotations, extreme logits и unavailable calibrator cases обязательны. Goldens raw probabilities получены через sklearn `predict_proba`, TS вычисляет их отдельно. Это проверка реализации, не измерение точности.

Независимая проверка1471строки: совпадение источника/label ID, ноль late rows, общие серии; пересчёт validation/calibration log loss другой формулой; train gradient максимум4.86e-11, производная calibration objective по T максимум5.28e-9. Coefficients до и после calibration совпадают. Эти метрики используются только для проверки fitting; поздняя оценка ещё впереди.

Frozen offline install, typecheck, 978 пакетных тестов и build PASS. Final post-build refit replay с недоступным DATABASE_URL PASS. Корректная копия воспроизводится; изменение коэффициента вместе с пересчитанными goldens/SHA отвергается. Повторный run не перезаписывает исходный. 57 SQL-файлов и historical checksums, docs links/whitespace/git diff --check PASS. Readiness: API/Web200, private401 без сессии, прежние model ID/report SHA/model_eligible и orchestration SHA. Сохраняются прежние Zod/chunk-size build warnings. Отдельные browser/PG integration suites не запускались: UI/API/SQL не менялись.

**Следующая задача: S3-04/player-hero-experiment-evaluation — закрепить evaluator и выполнить offline-сравнение H0/H1/H2 на позднем development-блоке: общий набор карт, log loss/Brier/ECE, парный bootstrap целых серий и срезы пропусков; без активации. Рекомендуемая модель: GPT-6 Astra · High.**
