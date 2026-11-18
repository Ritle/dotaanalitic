# S3-04 — контракт признака наблюдаемой практики игрока на герое

Реализован чистый TypeScript-модуль с одним исследовательским признаком. Он рассчитан для **881 train-карты и 306 validation-карт**, сохранив исходную пригодность R2. Обучения, новых вероятностей и изменения рабочего pre-match прогноза нет. Calibration и поздний development_test не вычислялись.

[Evidence, policy и SHA](evidence/s3-04-player-hero-feature-contract.json). [Предшествующий аудит покрытия](S3_04_PLAYER_HERO_FEATURE_AUDIT.md), [оценка прежних моделей](S3_04_R2_OFFLINE_EVALUATION.md).

## Закреплённое правило

Версия: `player-hero-observed-practice-90d-v1`. Единственный элемент feature order: `observedHeroPracticeLog90Delta`.

Для каждого выбранного игрока `n_i` — число **наблюдаемых локальных проверенных pro-карт** на выбранном герое за 90 дней до cutoff, завершившихся строго раньше cutoff. Одна карта учитывается для игрока один раз.

```text
x_i = ln(1 + n_i)
feature = (x_A1 + ... + x_A5) / 5 - (x_B1 + ... + x_B5) / 5
```

Положительное значение означает больше наблюдаемой практики у A. Оно **не означает** преимущество A, качество исполнения, высокий винрейт или вероятность победы. Здесь нет коэффициента модели. Окно 90 дней наследует диагностический горизонт предыдущего аудита; log1p — зафиксированная сжимающая трансформация счётчика, не параметр, подобранный по исходам. Оба решения — гипотеза для будущего эксперимента, их predictive benefit ещё не измерен. Варианты/окна/пороги не перебирались.

Среднее берётся по ровно пяти игрокам каждой стороны. Перестановка A/B меняет знак; порядок массива и Radiant/Dire не определяют A/B. Адаптер переносит стороны из прежнего scenario snapshot и отдельно сверяет знаки с signed heroes R2.

## Ноль, пропуски и окно данных

- `nRaw=0` — ноль **найденных** игр на герое в проверенном локальном окне. Это не доказательство отсутствия опыта. `log1p(0)=0` — точное преобразование счётчика; фиксированного штрафа нет.
- Предыдущие pro-карты с неизвестным героем сохраняются отдельно: `heroUnknownMaps` и точные `heroUnknownMatchIds`. Они не объявляются играми на другом герое и не скрываются из coverage. Счётчик остаётся наблюдаемой нижней границей; пригодность такого входа для модели ещё предстоит решить в экспериментальном протоколе.
- Локальная история не считается исчерпывающей. Для всех результатов есть `LOCAL_HISTORY_NOT_EXHAUSTIVE` и `ZERO_COUNT_NOT_ZERO_EXPERIENCE`.
- Если объявленный source window не покрывает всю область `[cutoff−90days; cutoff)`, возвращается `status: unavailable`, `feature: null`, обе side means null и конкретная причина начала/конца усечённого окна. Нельзя молча сокращать окно или усреднять только известных участников. Диагностические наблюдаемые counts сохраняются.
- В полном, но пустом локальном окне count и его разница могут быть 0 с предупреждением `NO_OBSERVED_HERO_PRACTICE`; это не вероятность 50/50.

В реальном train/validation проходе 11870 participant×target slots, 2710 нулевых наблюдаемых hero counts, 382 слотов с хотя бы одной более ранней pro-картой неизвестного героя в 90-дневном окне. Это показатели покрытия, не независимые training examples.

## Патчи, роли и доступность во времени

Это **сырой объём наблюдаемой практики**, объединяющий патчи и роли. Он не является patch-weighted оценкой силы героя: перенос навыка между патчами, hero-impact weights, role-aware performance и hero eligibility не реализованы. `PATCH_TRANSFER_NOT_VALIDATED` и `ROLE_NOT_CONDITIONED` обязательны. Canonical patch остаётся null, если неизвестен; same-canonical-patch count тоже null при неизвестном целевом патче. Метка провайдера в canonical patch не подставляется.

Полные требования patch/role-aware prediction остаются открытыми. Ограниченное решение этой задачи — вычислить и сохранить research input с прозрачным scope; это не исключение из production quality gates. Во всех выходах `publicationEligible: false`, `deployable: false`, независимо от заполненности полей.

`event/known/fetched` не смешиваются. На frozen корпусе known_at привязки «игрок—герой» не установлен, поэтому адаптер передаёт null. Поле `knownBeforeCutoffMaps` считает только записи с явно заданным ранним known_at **и** fetched_at; оно не заменяет полную проверку доступности будущего кандидата. Исторические финальные герои и выбранные после cutoff составы помечены отдельно. Сохранены source SHA, времена source window/snapshot/selection, точные IDs использованных карт и реальный target cutoff.

## Границы чистого модуля

`tools/research/player-hero-feature.mts` экспортирует `HistorySchema`, `ScenarioSchema`, `FEATURE_POLICY` и `createPlayerHeroFeatureBuilder(input)`. Входы проходят строгие Zod-схемы и дополнительные проверки; модуль компилируется TypeScript strict с noUncheckedIndexedAccess. Он намеренно находится вне production prediction exports и frozen shared source tree.

Обязательны десять различных canonical player IDs, numeric accounts и выбранных героев, пять участников на каждую сторону. Ники, организация и роли не используются для объединения истории. Для source maps нужны established pro boundary, проверенные receipt SHA/участники; адаптер переиспользует существующий verified-map/identity boundary, а чистый модуль принимает только его нормализованный контракт. Само поле `isPro: true` от произвольного клиента не является доказательством — публичного endpoint для такого ввода нет.

Нижняя граница 90 дней включается; `started_at < cutoff` и `completed_at < cutoff` строгие. Исключаются сама цель, равное время завершения, перекрывающиеся и будущие карты. Дубликаты, sentinel account, нечисловые/небезопасные IDs, противоречащие времена, лишние поля и pro=false отвергаются. Outcomes, GPM, KDA, длительность и вероятности отсутствуют в schema признака; попытка передать их как поля отклоняется. Исторические исходы использует только прежний verifier для допуска pro-истории.

Builder один раз валидирует и копирует history, затем детерминированно считает сценарии. Изменение caller history/результата не меняет последующие расчёты; feature order заморожен. Ошибка JSON/identity/time — отказ, а не тихий fallback.

## Реальный end-to-end результат

Manifest зарегистрирован **2026-11-13T17:49:01.338Z**, начало расчёта — **2026-11-13T17:49:14.439Z**. В нём закреплены policy, исходные SHA, TypeScript/Node/code/runtime и partitions до вычисления новых значений.

| Блок | Исходных целей | Рассчитано | Прежние исключения | Не запрашивалось |
|---|---:|---:|---:|---:|
| train | 1252 | 881 | 371 | 0 |
| validation | 398 | 306 | 92 | 0 |
| calibration | 338 | 0 | 0 | 338 |
| development_test | 223 | 0 | 0 | 223 |
| warmup | 6 | 0 | 0 | 6 |
| outside_window | 15 | 0 | 0 | 15 |

Все 2232 исходные target IDs и исходные причины/series/window сохранены. У 1187 рассчитанных карт нет усечённого source window; threshold по hero N не добавлен. Для 463 прежних исключений train/validation новый признак не рассчитывался. 582 строки остальных блоков имеют `not_requested` и null feature. Training labels не включены в новый артефакт; 10 строк игроков на карту не увеличивают sample count.

Результат `.tools/s304-hero-contract-r1/features.json` — 6686423 bytes, SHA `1192c3aed6ff47012a391d5733bfb3d79841e3c838132a0cb0526752f010b46d`. Предыдущие audit, R1/R2 dataset/fit/evaluation и активная модель не переписаны. Никакого provider HTTP, business writes, новых dependencies/миграций, fitting/calibration fitting, scoring или активации.

## Воспроизведение

```powershell
node tools/research/player-hero-feature-contract.mjs verify .tools/s304-hero-contract-r1
node node_modules/typescript/bin/tsc tools/research/player-hero-feature.mts --strict --noUncheckedIndexedAccess --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir .tools/s304-hero-feature-runtime
node --test tests/node/player-hero-feature.test.mjs
```

Для новой связанной ревизии: `register .tools/<new-directory>` компилирует runtime и фиксирует новый manifest, затем `create` пишет started и features только один раз. Старый каталог не переиспользовать. `verify` сверяет входы/code/runtime, повторяет предыдущий audit, считает новый результат и сравнивает весь fingerprint. Нормализованный source/history и вычисленные counts дополнительно сверены с исходным audit по каждому account/hero и точным recent IDs.

10 целевых тестов и strict TypeScript PASS. Проверены формула, ноль/unknown, окно/cutoff, исключение target/future, A/B sign, порядок, cross-account substitution, patch/known_at, лишние outcome/stat поля, mutation safety. Реальный replay и отказ повторного create PASS. Независимый Python oracle: **3561** сравнений scalar/side means и **23740** сравнений counts/точных IDs; максимум ошибки **8,881784197001252e-16**. Calibration/late test не вычислены.

Frozen offline install, общий typecheck, все 978 пакетных тестов и build PASS с первого прогона. Отдельная strict TypeScript-компиляция нового модуля и 10 целевых Node-тестов PASS. Финальный replay после сборки с недоступным DATABASE_URL PASS. Контрольная копия с корректно перепривязанным manifest прошла; изменение scalar даже с новым fingerprint отклонено полным пересчётом. Повторный create отказал до пересчёта, SHA оригинала сохранён. 57 SQL-файлов/исторические checksums, docs links, whitespace новых файлов и git diff --check PASS. Прежние warnings Zod annotations и web chunk >500 kB остаются. Read-only readiness: API/Web200, private endpoint401 без сессии, прежние model ID/report SHA/model_eligible. Browser/PG integration suites не запускались: UI/API/SQL не менялись.

**Следующая задача: S3-04/player-hero-experiment-plan — зарегистрировать сравнение базовой модели с одним новым признаком: правила обучения и калибровки, обработку пропусков, критерии качества и границы независимой проверки; прежние R1/R2 оставить development, без подбора по старому тесту и активации. Рекомендуемая модель: GPT-6 Astra · High.**
