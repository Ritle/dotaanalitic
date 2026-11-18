# S3-04/offline-fit — обучение исследовательских вариантов

13 ноября 2026. Продолжение [замороженной выборки](S3_04_FROZEN_DATASET.md) по [исходному протоколу](S3_04_CONDITIONAL_PLAN.md). **Обучение и калибровка завершены; качество на поздней выборке ещё не оценивалось.** Публикация и активация запрещены, существующий V1 не менялся.

## Входы и фиксация запуска

Запуск `.tools/s304-fit-r1` зарегистрирован2026-11-12T22:35:47.730Z, первое обучение началось22:36:09.853Z. До обучения закреплены code/compiled TypeScript/source SHA, dataset/protocol/input SHA, Python executable SHA, полный список установленных Python packages, платформа, BLAS/OpenMP, число потоков1, seed42, Node/TypeScript versions. Python3.11.9, scikit-learn1.8.0, numpy2.3.5, scipy1.17.0, joblib1.5.3, threadpoolctl3.6.0. Зависимости не устанавливались заново. Это запись реально использованного research environment; воспроизводимая production-установка с hash-pinned wheels остаётся отдельным release gate.

Регистрация повторно воспроизвела весь frozen dataset через прежний source/outcome/history verifier. После этого в отдельный Python input переданы **1471строка**:881train,306validation,284calibration.175пригодных development_test карт не переданы в Python и не используются для выбора C или temperature. Общая история ранее использовалась в разработке: это не заявление, что поздние исходы никогда не просматривались. Поздний блок сохраняет статус retrospective development, а не нового blind holdout.

Schema признаков связан с `conditional-elo-signed-heroes-v1` через frozen dataset SHA. Артефакт `conditional-logistic-research-fit-v1` отдельно фиксирует порядок признаков и коэффициенты. M1 использует только `eloLogit`; M2 — тот же Elo и127signed hero features, всего128коэффициентов. Никакого нового centering/scaling/imputation/intercept. Составы и герои исторически восстановлены; patch/roles остаются неизвестными, не получают фиктивную доступность до игры.

## Что обучено

L2 logistic/lbfgs, max_iter2000, tol1e-8, C-grid0.01/0.1/1, uniform map weights, без class weights. Train-only коэффициенты; validation выбирает C отдельно для каждого варианта. C сравниваются по возрастанию: следующий заменяет текущий лучший только при снижении loss более1e-12; train+validation refit отсутствует. Все шесть кандидатов сошлись; неудачный кандидат сохранялся бы как invalid.

| Вариант | Коэффициентов | Выбранный C | Temperature |
|---|---:|---:|---:|
| M1: Elo |1|1|0.7933639641|
| M2: Elo + герои |128|0.01|0.2905969508|

Temperature обучается только на284calibration-картах: bounded minimization log loss, T∈[0.25,4], xtol1e-8/max1000. Для численной проверки границы до запуска закреплён допуск1e-6. Граница/несходимость дают insufficient; raw модель сохраняется, calibrated probability остаётся null. У обоих реальных вариантов temperature внутри диапазона и оптимизатор сошёлся.

Полные validation losses всех кандидатов и calibration objective сохранены в [evidence](evidence/s3-04-offline-fit.json). Эти величины использовались для настройки; **они не являются независимой оценкой качества или доказательством улучшения от героев**. Базовый M0 остаётся прежним фиксированным player-mean Elo и не переобучается.

## Python ↔ TypeScript

Python golden outputs получены от sklearn `predict_proba`; calibrated outputs — sigmoid(selected logit/T). TypeScript выполняет отдельную реализацию dot product и устойчивой sigmoid.259входов на каждый изM0/M1/M2:128реальных train-векторов,128с переставленными сторонами и3арифметических stress-вектора с Elo logit−1000/0/+1000. Последние131пробы не являются новыми профессиональными картами или обучающими наблюдениями.

1554численных сравнения; максимальное абсолютное расхождение2.220446049250313e-16 при заранее заданном допуске<1e-7 — PASS. Дополнительно M0 сверён с существующей функцией `eloLink`. Внешний JSON проверяется Zod; TS отвергает неверный feature order, неизвестных/повторяющихся героев, NaN/Infinity, неправильную temperature. Компиляция отдельного `.mts` выполнена с strict/noUncheckedIndexedAccess. Файл не экспортируется из production prediction package и не используется HTTP endpoint.

## Сохранение и запуск

Новые файлы: `tools/research/post_draft_fit.py`, `post-draft-inference.mts`, `post-draft-fit.mjs`; тесты `tests/research/test_post_draft_fit.py`, `tests/node/post-draft-fit.test.mjs`. Shared production packages, исторические SQL, lockfile, старые ML tools, frozen V1 scripts и исходные S3-04 policy/dataset не менялись.

```powershell
# Проверка существующего результата; не запускает fit повторно.
node tools/research/post-draft-fit.mjs verify .tools/s304-fit-r1
# Для новой согласованной ревизии нужны отдельные пути и manifest ДО fitting.
node tools/research/post-draft-fit.mjs register .tools/s304-fit-config.json .tools/NEW-fit-revision
node tools/research/post-draft-fit.mjs run .tools/NEW-fit-revision
```

Регистрация читает config с точными input paths и expected dataset/protocol SHA. Все run directories разрешены только внутри `.tools`; создание файлов — exclusive. `started.json` создаётся до вызова Python: повторный run запрещён. Первый fitted artifact/result сохраняется; ошибка оставляет failed record, не перезаписывает старый результат. Verify проверяет environment/executable/input binding, SHA артефакта, parity и сохранённый result без переобучения. Коэффициенты сериализованы JSON, pickle/joblib не загружается.

Реальный result manifest SHA: `0ada189f2e2e4865f72983bac33810e6317bce234ad689d3484bd305dbd82816`; artifact SHA: `70916658f4db7162039a7a3bed772457aa5f387d3f0cc0025cfea64590500951`. Все связанные SHA, параметры и проверки — в evidence. Локальные артефакты с account/provenance evidence не включаются в git.

## Ограничение и проверки

`dataChecks=insufficient`:175/223=78,48% ниже зарегистрированных80%. Оно перенесено в fit artifact/result без изменения. Даже хорошие последующие метрики не дадут положительный полный research gate этого протокола. Ни обучение, ни успешный parity не разрешают активацию. Registry/API/сохранённые прогнозы не изменялись, provider HTTP0. Реальный source audit прошлого среза переиспользован.

23Python tests PASS, включая17новых;23целевых Node tests PASS, включая2новых. Проверены calibration isolation, train-only fitting/no refit, поздний split, серия/duplicate IDs, строгие labels/clocks/vocabulary, нечисловые входы, class/sample floors, C tie, несходимость, boundary calibration, extreme logits, swap symmetry, deterministic synthetic fit, sklearn↔TS parity и отказ при изменении коэффициента. CLI offline verify с invalid DATABASE_URL PASS; duplicate run сохраняет байты, неверный dataset SHA и environment отклонены до fit.54migration checksums PASS. Frozen install/typecheck/962общих tests/build PASS, docs links/diff PASS. После сборки verify сохранил artifact/result SHA; прежние dataset executable/protocol тоже совпали. Working preservation PASS:2232карты/3прогноза/3сценария/13точных строк очереди, исходный snapshot SHA, active model/model_eligible/readiness report прежние. Сервисы не перезапускались, general worker не включался. Полные standalone PG/browser suites не запускались: API/UI/SQL не менялись.

**Следующая задача: S3-04/offline-evaluation** — один раз сравнить зафиксированные M0/M1/M2 на тех же175поздних картах, вычислить Brier/log loss/calibration и95%интервалы с bootstrap целыми сериями по исходному протоколу. Сохранить первый результат, включая insufficient/negative; не менять C, temperature, окна или пороги. Без активации. Рекомендуемая модель: GPT-6 Astra · High.
