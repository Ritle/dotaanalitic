# S3-04/frozen-dataset — исследовательская выборка после пиков

Дата: 13 ноября 2026. Продолжение [зарегистрированного протокола](S3_04_CONDITIONAL_PLAN.md). Это отдельная локальная исследовательская выборка; модель не обучалась, оценки качества не рассчитывались, активация не выполнялась. Существующий V1 остаётся отдельным.

## Что подготовлено

`tools/research/capture-post-draft.mjs` читает исходы через существующий `V1DataRepository` / `OutcomeVerifier`. Проверка использует SELECT и SHARE locks, поэтому её транзакция не маркируется PostgreSQL READ ONLY. Отдельное чтение героев выполняется READ ONLY. Снимки связаны ревизиями карт, исходными receipt SHA, составами и зарегистрированным списком серий; изменение этих привязок останавливает построение. Между двумя чтениями нет общей транзакции: результат не объявляется атомарным снимком всей БД.

`post-draft-dataset.mjs` переиспользует `prepareV1MapHistory`, `prepareV1PerMapFeatureHistory` и `createV1FeatureBuilder`. История проверяется независимо от того, попала ли карта в целевую выборку. Всего пригодно2158исторических карт; для каждого target используются лишь начавшиеся и **завершившиеся строго раньше него**. Сам target исключён. Elo policy1500/K32/400 и минимум5карт на каждого игрока не менялись.

Team A — меньший **числовой** canonical team ID. Исторические стороны и native slots связывают состав, героев и исход; Dire не становится Radiant из-за порядка массива. Признаки: `ln(10) × eloDifference / 400` и signed presence героев (+1A/−1B). Словарь127героев построен только по финальным пригодным train-картам. Герой вне словаря оставляет baseline доступным, но исключает карту из парного сравнения с M2, с явной причиной.

Метки хранятся отдельно от `rows[].inputs` в `labels`. Вход не содержит текущий исход, длительность, статистику карты или номер карты в серии. `featureSnapshot` сохраняет состав, cutoff, receipt/hash и историю расчёта Elo; provenance hashes могут связывать весь снимок, но не используются как обучающие признаки. Потребитель должен брать только `pairedEligible` для общего M1/M2 набора и никогда не подавать весь audit snapshot на обучение.

## Итоговые размеры

| Блок | Знаменатель плана | Предварительные кандидаты | Пригодно для парного сравнения | Серий |
|---|---:|---:|---:|---:|
| Train |1252|1183|881|421|
| Validation |398|392|306|170|
| Calibration |338|335|284|124|
| Development test |223|216|175|80|

Старые warmup-карты используются как история, а не как обучающие targets. Пять предварительных warmup targets не имеют нужной предыдущей истории. Ранний пул истории сохраняется независимо от этого исключения. В итоговом ledger остаются все2232карты, включая101исключённую ещё протоколом и15вне временных окон.

Основная новая причина — `INSUFFICIENT_PLAYER_HISTORY`:281train/77validation/46calibration/39development_test. Непригодный target исключает остальные известные карты его серии из итогового набора; соответствующие общие исключения302/86/51/41. Числа причин пересекаются и не складываются. Это применение исходного требования о целых известных сериях до fitting, а не изменение окон или порогов.

**Покрытие позднего блока175/223 =78,48% ниже зарегистрированного минимума80%.** Размеры блоков, число серий и обеих меток проходят заданные минимумы, но `dataChecks.status=insufficient`, причина `DEVELOPMENT_TEST_COVERAGE_BELOW_0_80`. Даже хорошие последующие метрики не дадут положительный исследовательский gate по этому протоколу. Порог, знаменатель и исключения не ослаблены. Новые данные потребуют отдельной связанной ревизии; старый результат сохраняется.

## Ограничения

Это retrospective development на ранее использовавшейся истории, не новый независимый blind holdout. Исторические составы и финальные герои восстановлены после игры; known-at до драфта не доказан. Patch/roles остаются неизвестными и не добавлены в признаки. Фактические номера карт неизвестны: набор содержит карты любого номера, не заявляется first-map-only. Полнота удалённых серий не доказана, проверены все локально известные siblings. `deployable:false` сохраняется во всех артефактах.

Прежний live source audit20карт используется повторно; новых provider HTTP нет. Источники и исходы повторно проверены локально, working DB/active model не изменяются.

## Воспроизведение

Локальные source capture и frozen dataset находятся в `.tools`, содержат account/provenance evidence и не включаются в общий git. Сводные SHA и результаты — [evidence](evidence/s3-04-frozen-dataset.json). Для будущих срезов по лигам и provider patch IDs использовать исходный `.tools/s304-final.json`, SHA которого закреплён протоколом; неизвестный canonical patch не заменять provider label. Этот inventory сохраняется вместе с capture и dataset. Файлы создаются только через `wx`; повторная запись запрещена. Offline verify повторно строит все строки и проверяет полный результат, source/protocol SHA и executable manifest.

```powershell
node --env-file-if-exists=.env tools/research/capture-post-draft.mjs .tools/s304-final.json .tools/s304-plan-metadata-final.json docs/evidence/s3-04-conditional-protocol.json .tools/NEW-capture.json
node tools/research/freeze-post-draft.mjs create .tools/s304-final.json .tools/s304-plan-metadata-final.json docs/evidence/s3-04-conditional-protocol.json .tools/NEW-capture.json .tools/NEW-dataset.json
node tools/research/freeze-post-draft.mjs verify .tools/s304-final.json .tools/s304-plan-metadata-final.json docs/evidence/s3-04-conditional-protocol.json .tools/NEW-capture.json .tools/NEW-dataset.json
node --test tests/node/post-draft-dataset.test.mjs tests/node/post-draft-plan.test.mjs tests/node/post-draft-readiness.test.mjs
```

Source capture созданный другим executable manifest не подходит: требуется новая связанная версия. Подмена содержимого с пересчитанной внутренней fingerprint обнаруживается детерминированным replay. CLI отказывается формировать реальный dataset из synthetic capture; тестовые фикстуры работают только через чистую функцию и сохраняют `syntheticOnly:true`.

## Проверки и продолжение

21целевой Node test PASS, включая10новых: отдельно labels/features, bigint/Dire mapping, влияние прошлых и независимость текущих/будущих результатов, строгая граница completion, train-only vocabulary, целая серия и независимая история, изменение ревизий/source/lineup, некорректные герои/аккаунты, нулевые выборки, перестановки строк и инвариантность при смене Radiant/Dire. Проверка обязательного недостаточного покрытия сначала RED, после явного `dataChecks` GREEN.

Offline replay при неверном DATABASE_URL, отказ от перезаписи с сохранением байтов, отказ от подменённого и повторно хешированного артефакта, отказ от synthetic CLI PASS. Независимая проверка готового файла подтвердила2232уникальных map IDs,1646paired maps, целые серии в своих folds, train-only словарь и1 900 509строгих временных связей с историей.54migration checksums/docs links/diff PASS. Frozen install/typecheck/962общих tests/build PASS. После сборки executable manifest и зарегистрированный протокол совпали. Сохранность рабочей БД PASS:2232карты,3прогноза,3сценария,13точных строк очереди, прежний snapshot SHA и model_eligible/readiness report без изменений. Полные standalone PG/browser/Python suites не запускались; UI/SQL/fitting не менялись.

**Следующая задача: S3-04/offline-fit** — реализовать зарегистрированное обучение M1/M2, temperature calibration и проверку Python↔TS на этой зафиксированной выборке. Сначала зафиксировать executable/environment manifest; пороги и окна прежние. Результат остаётся диагностическим, общий gate уже ограничен недостаточным покрытием; без активации и пользовательских вероятностей. Рекомендуемая модель: GPT-6 Astra · High.
