# S3-01/V1-historical — воспроизводимый запуск исторической оценки

**Обновление 6 ноября:** [первая оценка выполнена, quality gate FAIL](S3_03_V1_HISTORICAL_EVALUATION.md); модель inactive. Регистрационный checkpoint внизу описывает состояние до первого scoring и сохраняется без изменения его SHA.

Исторический тест получает отдельный формат исполнения. Прежний будущий release plan, E0/E1 и старый executable bundle остаются архивными. Новая регистрация фиксирует код и данные **до первого расчёта на тестовых картах**, с честными текущими часами. Она не делает исторические составы известными до начала тех игр.

## Что фиксируется

`scripts/historical-v1.mjs freeze` повторно проверяет исходный import plan и SHA всех его источников, канонический dataset и исходный протокол. В переносимый `frozen/input.json` входят точные исходные байты протокола, каталога лиг, exposure manifest, import plan и dataset, а также воспроизводимая проверка покрытия. Сырые ответы отдельных матчей сохраняются в исходном локальном store; они проверяются при создании пакета, но не дублируются в нём. Для повторного scoring достаточно канонического snapshot с evidence; полный повтор первоначального импорта требует также исходного store.

`frozen/executable.json` связывает SHA входного файла, dataset/protocol/candidate/ledger fingerprints, manifest исполняемых модулей, lockfile, миграций, package manifests и версию/хеш Node. `frozen/manifest.json` содержит краткое описание. В отдельную папку копируются эти файлы и исполняемый код. Секреты, `.env`, owner access и рабочая БД туда не попадают. Зависимости устанавливаются отдельно по неизменному lockfile; перед scoring проверяется, что workspace imports указывают именно в frozen copy.

Fixed Elo остаётся прежним: 1500 / K32 / scale400, минимум пять завершённых более ранних pro-карт на игрока. Новый scorer использует существующий `createV1FeatureBuilder` и ту же `eloLink`, что прежний кандидат и runtime. Никакого fitting/tuning или новой калибровки на этом тесте нет. Параметры, числовые пороги и bootstrap не изменены.

## Оценка и сохранение результата

Команда `evaluate` работает только из проверенной frozen copy. Сначала она эксклюзивно создаёт каталог `evaluation` и сохраняет с `fsync` первую попытку в `started.json`. Повторная команда не перезаписывает его. При ошибке остаются первая попытка и `failed.json`; результат нельзя заменить повторным запуском. Исправления требуют отдельно описанной новой ревизии с сохранением первой попытки.

Успешный расчёт создаёт `report.json` с признаками, исходами, метриками, покрытием и ссылками на sources/code, а также `registry.json`. Последний — отдельный **контракт передачи** исторической оценки: он создаётся только после полного повторного расчёта отчёта. Подставленные `passed`, вероятность или метрики отклоняются. `replay` воспроизводит расчёт и проверяет также первоначальную запись попытки и сохранённый registry binding.

Все ранее обнаруженные unexposed targets остаются в знаменателе. Неизвестная или неполная серия исключается целиком. Team A определяется меньшим числовым ID команды; при смене ориентации одновременно меняются пятёрка и метка. В историю входят только карты, завершившиеся **строго раньше** начала текущей. История ранее сыгранных тестовых карт может участвовать в последующих по зарегистрированному prequential protocol. Exposed серии не входят в test metrics, но их более ранняя проверенная история не удаляется из Elo.

Положительный численный результат ещё не активирует модель. Синтетика всегда `releaseGatePassed:false`. Даже для настоящего PASS остаются `isActive:false`, `deployable:false`, `teamAWinProbability:null`. Старый production registry этот новый формат не принимает: его отдельный адаптер, транзакционная регистрация и runtime compatibility проверяются после независимого quality gate. Сейчас новый registry binding не является записью активной модели в БД.

## Команды

После сборки проекта:

```powershell
# CONFIG: {schemaVersion:1, importPlan:{path,sha256}, dataset:{path,sha256}}
node scripts/historical-v1.mjs freeze CONFIG CONFIG_SHA NEW_BUNDLE
node scripts/historical-v1.mjs verify BUNDLE FREEZE_SHA INPUT_SHA

# В frozen copy установить зависимости именно для этой копии.
# Не запускать build: зафиксированы уже собранные исполняемые файлы.
Set-Location -LiteralPath BUNDLE
pnpm install --offline --frozen-lockfile --ignore-scripts
node scripts/historical-v1.mjs verify . FREEZE_SHA INPUT_SHA

# Отдельный следующий этап — первый реальный quality gate.
node scripts/historical-v1.mjs evaluate . FREEZE_SHA INPUT_SHA
node scripts/historical-v1.mjs replay . FREEZE_SHA INPUT_SHA
```

Не удалять `evaluation`, не менять freeze и не выбирать лучший результат среди копий. Закреплённые SHA конкретного локального пакета публикуются в evidence. Локальные labeled inputs/reports остаются в игнорируемой `.tools`; один git checkout без них не воспроизводит эмпирический результат.

Ограничения остаются прежними: условная реконструированная пятёрка, current numeric identities, допущение доступности исхода по времени завершения, ограниченный локальный аудит прежнего доступа, возможность знания публичных результатов и неполная внешняя история. Это проверка на выбранных выпусках Tier 1, а не доказательство универсальной или prospective точности.

## Зарегистрированный пакет 6 ноября 2026

[Freeze](evidence/s3-01-v1-historical-executable-freeze.json), [результат проверок](evidence/s3-01-v1-historical-executable-checkpoint.json). Локальная папка: `.tools/v1-historical-freeze-20261106/bundle`. Freeze SHA `0b632fecd6db7860937e3c94923b20ce24d891cf22bc4a864b442557a7bbaf34`; input SHA `34d35e9f9a626c355d82916211226f3ab944a5072dbc1e7a0e40119907c1bfd6`. Зарегистрирован 2026-11-06T15:35:16.050Z; 373 исполняемых/config файлов. Dataset SHA `6396235552a52691b7611e35c0900ee70eaae139ea07370b89cf561212b53045`, готовность140/145 maps и58/60 series сохранена. Реального scoring ещё не было; каталог evaluation отсутствует.

Проверки: 892 unit/CLI при полном последовательном прогоне, 171 Node, install/typecheck/build,49 SQL, docs links, archive preservation и frozen-copy verify PASS. Первые sandbox EPERM/parallel timeouts и способы повторов отражены в checkpoint. Рабочая модель не активирована. Следующая задача: **S3-03/V1-historical/independent-evaluation**.
