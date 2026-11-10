# S3-01 / S3-03 — подготовка отдельной оценки retest v2

**Обновление 10 ноября:** [реальный executable freeze завершён](S3_01_V1_RETEST_EXECUTABLE.md), проверена отдельная копия с новым plan/export в зарегистрированном периоде. Следующий шаг — independent evaluation. Дальнейший текст описывает ранее завершённую подготовку; новой реальной оценки или активации пока не было.

По прямому выбору владельца реализован путь `scripts/retest-v1.mjs freeze|verify|evaluate|replay`. Это подготовка к оценке после [завершения сбора](S3_01_V1_RETEST_COLLECTION.md) и [канонического импорта](S3_01_V1_RETEST_IMPORT_PREPARATION.md). Реальный retest dataset/executable ещё не зафиксирован, новые метрики на реальных картах не рассчитывались. Первый исторический FAIL и его исполняемый код сохраняются.

## Вход и воспроизводимость

`freeze` принимает config версии 2 с двумя SHA-bound файлами: `importPlan` и `dataset`. Сначала штатный импортёр повторно проверяет терминальную closure, журнал исходных ответов, справочники и доказательства аккаунтов. Открытая коллекция отклоняется до доступа к dataset, БД или создания bundle; сетевого fallback нет.

В переносимый `frozen/input.json` входят точные байты протокола, всех его входных документов, discovery captures, access evidence, ссылок и документов предыдущей неудачной попытки, import plan, closure, source manifest и canonical dataset. Каждая ссылка проверяется по SHA; неизвестные и повторные источники отклоняются. Protocol replay заново проверяет неизменную политику, порядок событий и исключения. Сырые детали отдельных карт остаются в исходном store: они проверяются при подготовке, но не копируются в bundle. Повтор первоначального импорта требует сохранённого store; повтор оценки использует переносимый canonical snapshot.

`frozen/executable.json` фиксирует SHA capsule/dataset/closure/manifest/предыдущего report, fingerprints политики, кандидата и полного target ledger, точный код, lockfile, package manifests, SQL и Node runtime. Код и входы копируются в новую папку. Зависимости устанавливаются отдельно по lockfile; workspace imports должны разрешаться внутри frozen copy. `.env`, пароль владельца и рабочая БД не копируются. Bundle содержит данные и доказательства, предназначенные для локального хранения.

Список обнаруженных target IDs нельзя уменьшить, продублировать или переименовать. Пропущенные карты остаются в знаменателе; неполная известная серия исключается целиком. Неизвестную серию можно уточнить, а prior exposure распространяется на всю связанную серию; произвольное дополнительное исключение запрещено. Для готовой карты время начала и стороны сверяются с зарегистрированными metadata. Closure и canonical coverage проверяются до первого scoring.

## Неизменная математика и отдельная первая попытка

Используется прежний `scoreHistoricalEvaluation`, без изменений его файла, feature builder или quality kernel. Внутренний адаптер передаёт базовый SHA политики из проверенного предыдущего протокола и disclosures v2. Сохранённый протокол v2 не переписывается. Параметры Elo остаются 1500 / K32 / scale400; минимум пять завершённых более ранних pro-карт на каждого из десяти разных проверенных аккаунтов. Нет подбора параметров, fitting, новой калибровки или ослабления порогов.

Team A — меньший числовой ID команды; при смене стороны одновременно меняются пятёрка и метка. История строго завершена до начала оцениваемой карты; целевая карта и ещё не завершённые карты не входят в признаки. Retrospective reconstructed-lineup basis, ограниченность локального exposure audit, предыдущий FAIL и отсутствие familywise/prospective claims сохраняются в отчёте.

`evaluate` разрешён только из проверенной frozen copy. До расчёта создаётся новый каталог `evaluation` и записывается первая попытка `started.json` с `fsync`. Повторная команда получает `OUTPUT_EXISTS`; ошибочная первая попытка также сохраняется. Успех создаёт `report.json` и после полного повторного расчёта — `registry.json`. `replay` проверяет исходную попытку и воспроизводит отчёт, включая метрики и binding. Не удалять `evaluation`, чтобы повторить первый тест; исправление требует отдельно описанной ревизии.

`registry.json` — контракт передачи результата, а не запись или активация рабочей модели. `legacyRegistryCompatible:false`, `isActive:false`, `deployable:false`. Даже пройденный реальный quality gate требует отдельного stage-safe registry/activation шага. Синтетические проверки всегда дают `releaseGatePassed:false` и не проходят production preparation/importer; тестовые capsules создаются только тестовыми helpers.

## Запуск после закрытия и импорта

Команды ниже описывают полный порядок, а фактически выполненный freeze указан в [текущем отчёте](S3_01_V1_RETEST_EXECUTABLE.md). После успешного export создать **новый** JSON config с `schemaVersion: 2`, `importPlan: {path, sha256}`, `dataset: {path, sha256}`. Пути указывают на проверенный план v2 и соответствующую версию экспорта; SHA вычисляются из точных файлов. Текущий config — `.tools/v1-retest-freeze-20261110/config-v2.json`, plan и export находятся в `scope-01`. Старый bundle первой оценки не использовать как output.

```powershell
pnpm shared:build
$executionConfig = '.tools/v1-retest-execution/config.json'
$executionSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $executionConfig).Hash.ToLowerInvariant()
$retestBundle = '.tools/v1-retest-execution/bundle'
node scripts/retest-v1.mjs freeze $executionConfig $executionSha $retestBundle
```

Сохранить SHA из созданного manifest. Установить локальные зависимости внутри новой копии без изменения lockfile; не собирать её повторно из текущего checkout. Использовать тот же Node binary. Затем:

```powershell
pnpm --dir $retestBundle install --offline --frozen-lockfile --ignore-scripts
$retestFreezeSha = (Get-FileHash -Algorithm SHA256 -LiteralPath "$retestBundle/frozen/executable.json").Hash.ToLowerInvariant()
$retestInputSha = (Get-FileHash -Algorithm SHA256 -LiteralPath "$retestBundle/frozen/input.json").Hash.ToLowerInvariant()
node "$retestBundle/scripts/retest-v1.mjs" verify $retestBundle $retestFreezeSha $retestInputSha
node "$retestBundle/scripts/retest-v1.mjs" evaluate $retestBundle $retestFreezeSha $retestInputSha
node "$retestBundle/scripts/retest-v1.mjs" replay $retestBundle $retestFreezeSha $retestInputSha
```

При недостатке офлайн-кэша зависимостей остановиться, сохранив bundle; не заменять зависимости симуляцией. Перед реальной оценкой проверить closure/import/coverage и отсутствие предыдущей попытки именно для этого retest. Текущий срез не даёт допуска модели и не показывает пользователю вероятность.

## Проверки и следующий шаг

Результаты проверок и границы выполненного среза: [checkpoint](evidence/s3-01-v1-retest-execution-preparation.json). Синтетические тесты проверяют SHA/protocol/closure/ledger binding, полноту серий, cutoff, смену сторон, запрет подмены passed, замороженный CLI, replay и запрет повторной первой попытки. На настоящей открытой коллекции отдельно проверяется отказ `RETEST_IMPORT_COLLECTION_NOT_CLOSED` без создания bundle.

7 ноября: offline frozen install, typecheck, build и 49 migration checksums — PASS. Все 892 уникальные unit/CLI и 226 Node-проверок прошли с учётом целевых повторов, включая 14 новых. Первый общий прогон обнаружил изменение executable SHA во время правки нового модуля; при неизменном коде эта проверка прошла. В последовательном прогоне один старый CLI-тест записал более часа elapsed time и превысил 60-секундный timeout; отдельный повтор прошёл за 13 секунд без изменения таймаута. В новой отрицательной фикстуре уточнена причина исключения, чтобы проверять нужный guard; затем все 14 новых тестов прошли. Production gates не ослаблялись. Исправление `null` series подтверждено отдельным RED → GREEN: неизвестная старая серия не связывает несвязанные неизвестные targets.

Файловая сверка после сборки сохранила 2632 файла коллекции, 245 защищённых артефактов, 373 прежних frozen/current code files и первый отчёт. На старте работ БД/API/Web были доступны: 83 public-таблицы, 939 карт, active0. При завершающей проверке PostgreSQL/API/Web уже не запущены; повторную сверку таблиц и очереди нельзя считать выполненной. Сервисы в этом срезе не запускались. Интеграционные PG, браузерные, Python и Docker/Linux suites не повторялись; новые изменения относятся к offline executor. Положительный production prepare/import/freeze/evaluate остаётся после завершения реального сбора.

**Следующий точный шаг: S3-01/V1-retest/collection** — запустить локальный PostgreSQL, догрузить 25 карт истории с проверкой текущей квоты, закрыть сбор и выполнить канонический импорт/сверку. Плановое время возобновления — 7 ноября 03:00 МСК — уже наступило; это не подтверждение доступной квоты провайдера. Затем зарегистрировать отдельный реальный executable freeze до первой оценки. Рекомендуемая модель: **GPT-6 Astra · Extra High**.
