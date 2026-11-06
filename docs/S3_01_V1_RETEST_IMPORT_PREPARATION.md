# S3-01/V1-retest/canonical-import/preparation

По выбору владельца подготовлен отдельный импортёр для [коллекции v2](S3_01_V1_RETEST_COLLECTION.md), пока действует дневной лимит OpenDota. Подготовка кода не означает завершение сбора, импорт рабочей БД или пройденную проверку модели. Старый импортёр v1 и первый исторический FAIL сохраняются.

## Что реализовано

`scripts/import-v1-retest.mjs` принимает команды `manifest`, `prepare`, `verify`, `identities`, `maps`, `series`, `export`. У него нет сетевого fallback: карты, справочники и числовые доказательства аккаунтов читаются из сохранённых ответов. Применение использует существующие `IdentityProvisioner`, `IngestionService`, `SeriesProvisionRepository` и `V1DataRepository`.

1. **Закрытая коллекция обязательна.** Отсутствие `closure.json` вызывает `RETEST_IMPORT_COLLECTION_NOT_CLOSED` до чтения полной коллекции, обращения к БД или создания import manifest. Импортёр не закрывает сбор сам. Допускается проверенное завершение всех работ либо closure по зарегистрированному deadline с явными пропусками.
2. **План воспроизводится перед каждым этапом.** Manifest фиксирует SHA допуска каждого HTTP, ответов, кэша, запусков, восстановлений и closure. План связывает этот manifest, протокол, базовый canonical snapshot, все карты, причины отказов и numeric identity proofs. Изменение любого входного источника требует нового проверенного плана; старый файл не заменяется.
3. **Неполные данные остаются явными.** Отсутствующее доказательство аккаунта даёт `NUMERIC_PROOF_MISSING`; совпадение ников не объединяет игроков. Конфликт существующей связи не перезаписывается. Неподтверждённая серия получает причины отказа, без выдуманных команд, BO3 или победителя серии.
4. **Противоречия истории проверяются отдельно.** Несовпадение исхода, времени, лиги, аккаунта или native slot между списком истории и деталями даёт `HISTORY_DISCOVERY_CONFLICT`. Такая карта не импортируется этим планом. Если она уже находится в экспортируемой canonical базе, экспорт останавливается: нельзя незаметно вернуть конфликтующую историю в признаки.
5. **Повтор безопасен для данных.** Каждая запись проходит штатную транзакцию и получает отдельный receipt. После ошибки повторяется тот же проверенный план с новым output directory; уже сохранённые карты не дублируются. Все исходные target IDs и исключения целых серий остаются в отчёте покрытия.

Сохраняются настоящие `fetched_at`/`known_at`, проверка исходов, native sides, десять разных аккаунтов и строго более ранняя завершённая pro-история. Неизвестные неиспользуемые V1 роли и патчи не становятся новыми признаками или искусственными значениями. Экспорт не вычисляет Elo, вероятность, метрики качества и не активирует модель. Синтетические данные из тестовых БД по-прежнему отклоняются production-exporter.

## Порядок запуска после завершения сбора

Для текущей коллекции сначала догрузить оставшуюся историю и получить неизменяемую closure штатным сборщиком. До этого следующая команда ожидаемо отказывает:

```powershell
New-Item -ItemType Directory -Path .tools/v1-retest-import
$collection = '.tools/v1-retest-collection-20261106/store'
$collectionSha = '916da747453e2bdb02bf58dc3c7b6aaa07991b20e214c5f9646bdbc98fd5378d'
node scripts/import-v1-retest.mjs manifest $collection $collectionSha .tools/v1-retest-import/manifest.json
```

После успешного manifest создаётся **новый** config формата `RetestImportConfigSchema`: `schemaVersion: 2`, `collection: {directory, sha256}`, `sourceManifest`, `heroes`, `registry`, `profiles`. У каждого файла — точные `{path, sha256}`; profile дополнительно содержит `accountId`. Схема соответствует прежнему import config по ссылкам на справочники, но принимает только коллекцию и manifest v2. Сохранённые heroes/registry/profile refs из `.tools/v1-historical-import-20261106/config.json` можно переиспользовать после проверки SHA; отсутствующие доказательства остаются blocked. Никаких фиктивных SHA или незаметного запроса новых профилей.

```powershell
$config = '.tools/v1-retest-import/config.json'
$configSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $config).Hash.ToLowerInvariant()
$plan = '.tools/v1-retest-import/plan.json'
node scripts/import-v1-retest.mjs prepare $config $configSha $plan
$planSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $plan).Hash.ToLowerInvariant()
node scripts/import-v1-retest.mjs verify $plan $planSha .tools/v1-retest-import/verify-01
node --env-file-if-exists=.env scripts/import-v1-retest.mjs identities $plan $planSha .tools/v1-retest-import/identities-01
node --env-file-if-exists=.env scripts/import-v1-retest.mjs maps $plan $planSha .tools/v1-retest-import/maps-01
node --env-file-if-exists=.env scripts/import-v1-retest.mjs series $plan $planSha .tools/v1-retest-import/series-01
node --env-file-if-exists=.env scripts/import-v1-retest.mjs maps $plan $planSha .tools/v1-retest-import/maps-linked-01
node --env-file-if-exists=.env scripts/import-v1-retest.mjs maps $plan $planSha .tools/v1-retest-import/maps-repeat-01
node --env-file-if-exists=.env scripts/import-v1-retest.mjs export $plan $planSha .tools/v1-retest-import/export-01
```

Каждый output path должен быть новым. Полная проверка крупной коллекции может занимать несколько минут. Не запускать конкурирующие процессы и не снимать lock работающего процесса. При восстановлении lock журнал recovery меняется; прежде чем применять старый plan, нужно повторно проверить его SHA-bound manifest, при необходимости создать отдельную новую версию. Ни общий worker, ни автоматическая загрузка, ни запуск по расписанию не нужны для этих команд.

Рабочее выполнение этих команд и финальный frozen dataset относятся к следующему этапу после закрытия сбора. Для независимой оценки потребуется отдельный новый executable freeze; подготовленный адаптер не заменяет его.

## Проверки текущего среза

[Checkpoint](evidence/s3-01-v1-retest-import-preparation.json), 2026-11-06T19:49:42.352Z. Frozen offline install/typecheck/build, 892 unit/CLI и 212 Node tests (12 новых) прошли. Четыре отдельных PostgreSQL-кейса проверили numeric identities, стороны и серии, повтор без изменения всех таблиц, отсутствие fallback при пропуске proof, отказ при неполных командах, частичную ошибку и продолжение. Синтетический production export ожидаемо отклонён. Первоначальные ошибки фикстур (synthetic flag и отсутствующие team objects) исправлены без ослабления production gates.

На настоящей незакрытой коллекции manifest вернул `RETEST_IMPORT_COLLECTION_NOT_CLOSED` с `writesAttempted:false`; output не создан. Полный положительный live plan/import/export ещё не выполнялся. Не изменились 83 рабочие public-таблицы, 939 карт, очередь и 2632 файла коллекции; 245 защищённых артефактов и 373 файла первого frozen bundle сохранены. Обращений к провайдерам, рабочего импорта, новой оценки и активации не было. API/Web: 200. Полные PG/browser/Python/Docker/Linux suites не повторялись.

**Следующий точный шаг: S3-01/V1-retest/collection** — оставшиеся 25 карт истории после 7 ноября 03:00 МСК, затем закрыть коллекцию и применить подготовленный импортёр. **GPT-6 Astra · Extra High**.
