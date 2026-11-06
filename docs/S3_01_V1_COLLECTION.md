# S3-01/V1 — управляемый сбор источников

**Обновление 6 ноября:** команды ниже относятся к неизменному старому протоколу. [Проверка выполнимости](S3_01_TIER1_PREFLIGHT.md) установила34 серии в объявленном формате BLAST IX против требуемых40. Collector остаётся технически пригоден, но полный сбор этого одного события не устраняет недостаточную выборку. Для объединённого теста с DreamLeague30 [подготовлены intent/CLI](S3_01_V1_RELEASE_REVISION.md); main-event binding и полная регистрация ещё открыты. Старые SHA/каталоги/пороги не заменять и не использовать старый collection для нового плана.

Срезы `collection/discovery` и `collection/details`, 5 ноября 2026. Операторский CLI управляет существующими закреплёнными collector и detail verifier. Он не обучает модель, не считает метрики и не меняет протокол. Реальное окно ещё не началось; [план и сроки](S3_01_V1_EVALUATION_READINESS.md) остаются прежними.

## Использование на этом ПК

Из корня `dotaanalitic`:

```powershell
$taskCollection = '.tools/v1-release-collection-managed'
$taskCollectionSha = '608bbda93be9c81b960ea6f16dcc59f305a3eeeeb2feec4a54ad21349d8e6895'
node scripts/v1-collection.mjs status $taskCollection $taskCollectionSha
```

`status` проверяет SHA конфигурации и закреплённый оценщик, показывает окно, сохранённые попытки, остаток лимита и блокировку. Он не обращается к провайдеру. На 5 ноября результат — `not_started`, запусков 0, доступно 10.

Когда начнётся окно (20 ноября, 03:00 МСК), первая загрузка:

```powershell
node --env-file-if-exists=.env scripts/v1-collection.mjs collect $taskCollection $taskCollectionSha 1
```

Номер следующей новой попытки — `2`, затем `3` и так далее, максимум `10`. Повтор **того же номера** проверяет уже сохранённые данные и возвращает `already_captured`, не повторяя HTTP. До начала окна команда возвращает `not_started` без API-запросов и расходования попытки. После 2 декабря, 03:00 МСК новая загрузка запрещена; проверять и объединять ранее сохранённые данные можно.

Объединить все успешные и частичные source captures:

```powershell
node scripts/v1-collection.mjs merge $taskCollection $taskCollectionSha
```

Команда повторно проверяет каждый capture старым оценщиком и создаёт новый `union.json`, список всех refs, итоговый SHA и результат в отдельном каталоге `unions`. Старые версии остаются на месте. **Удачный merge не означает готовность оценки:** нужны все detail batches, canonical identities/series/outcomes, достаточная предыдущая история и независимая проверка качества.

Фоновое расписание не создано. Команда выполняется явно оператором; открытие сайта не запускает сбор. Планируйте ограниченное число сборов с резервом на ошибки, а не частый polling. Лимит 10 взят из уже закреплённого union reader. Partial source runs не исключаются: они могут оставить весь union partial, согласно неизменному оценщику.

## Ошибки и восстановление

Перед HTTP создаются отдельная запись `attempts/NN.json` и каталог `runs/NN` с таким же intent. Результат/ошибка сохраняются отдельным файлом. Потеря каталога, пропущенный номер, неверный SHA или неоконченная попытка блокируют новый сбор и объединение; такие случаи нельзя молча исключить из выборки.

Если сохранён полный manifest и процесс завершился, можно восстановить учёт без повторной загрузки:

```powershell
node scripts/v1-collection.mjs recover $taskCollection $taskCollectionSha
```

Старый failed `result.json` остаётся неизменным; успешная проверка дописывает `recovery.json`, привязанный к SHA первоначальной ошибки и intent. Для оборванного запуска без result создаётся результат с `recovered:true`. В обоих случаях используется исходный capture, а не новый ответ API. При неполном/невалидном capture восстановление отклоняется и исходные файлы сохраняются для разбора.

`lock.json` запрещает параллельные collect/merge/recover. После штатного завершения инструмент снимает свою блокировку. После принудительного убийства процесса блокировка **не снимается автоматически**, даже если PID родителя уже не существует: его дочерний collector может ещё работать. Перед ручным удалением только этого lock-файла оператор должен проверить завершение обоих процессов и принадлежность пути нужной коллекции. После этого выполняется `recover`; receipts, intents и results не удаляются. Автоматического обхода блокировки по таймауту нет.

Это локальный журнал с проверками целостности, не внешняя подпись и не защита от администратора, переписавшего все файлы. Для воспроизводимости храните коллекцию и её SHA вместе с bundle и резервной копией данных. Конфигурация содержит абсолютные пути; перенос требует отдельного проверенного плана переноса, а не редактирования старого manifest на месте.

## Создание новой коллекции

Для нового, заранее согласованного набора используется эксклюзивный `init`; для обычных повторов существующего сбора новый каталог создавать не нужно:

```powershell
node scripts/v1-collection.mjs init .tools/v1-frozen-runtime CONFIG_SHA FREEZE_SHA NEW_DIRECTORY
```

`CONFIG_SHA` и `FREEZE_SHA` берутся из проверенного [freeze](S3_03_V1_EXECUTABLE_FREEZE.md). Команда возвращает `collectionSha256`, обязательный для следующих вызовов. Init проверяет pinned plan/kernel/Node/code до создания файлов; каталог внутри оценщика или существующий каталог отклоняется. Секреты не копируются. Прямые команды запускают старый collector из bundle; файлов bundle, миграций и ML-policy новый код не меняет.

## Детали карт: полный набор пакетов

После `merge` используйте точные `unionPath` и `unionSha256` из результата. Сначала завершите запланированные discovery-запуски: новый discovery делает старый union устаревшим для новых загрузок и экспорта. Старые пакеты сохраняются для аудита; автоматически переносить их в новый union нельзя, поскольку проверяющий код закрепляет SHA union в каждом capture.

```powershell
# Подставьте значения из результата merge, без изменения файлов union.
$taskUnionPath = 'путь из unionPath'
$taskUnionSha = 'SHA из unionSha256'
node scripts/v1-collection.mjs details-init $taskCollection $taskCollectionSha $taskUnionPath $taskUnionSha
node scripts/v1-collection.mjs details-status $taskCollection $taskCollectionSha $taskUnionSha
```

`details-init` проверяет все исходные discovery receipts и создаёт неизменный план: числовая сортировка строковых ID, по 50 карт на пакет. Включаются возможные целевые карты и связанные карты той же серии за границей окна. При нуле карт — ноль пакетов; это не успешная проверка модели. Список всех ранее подготовленных планов доступен через `details-status` без последнего SHA.

Сбор выполняется по одному индексу из `missing` в результате `details-status`:

```powershell
node --env-file-if-exists=.env scripts/v1-collection.mjs details-capture $taskCollection $taskCollectionSha $taskUnionSha 0
node scripts/v1-collection.mjs details-status $taskCollection $taskCollectionSha $taskUnionSha
```

Индексы начинаются с 0, допустимы только существующие пакеты (не более 100). Существующий frozen client сохраняет timeout/retry/quota/Retry-After; одна команда загружает не более 50 карт и две справочные выдачи, до трёх попыток на запрос. Новые загрузки разрешены с 20 ноября 03:00 МСК строго до 2 декабря 03:00 МСК. Повтор того же индекса проверяет сохранённые байты без HTTP, включая повтор после дедлайна. Команда не запускает автоматически остальные пакеты.

План хранится в `detail-plans/<union SHA>.json` и `details/<union SHA>/plan.json`; отдельные `attempts/NN.json` позволяют обнаружить потерю последнего каталога пакета. SHA ранее завершённых manifest проверяются до новой загрузки. Discovery и детали используют один `lock.json` и те же правила ручного разбора зависшей блокировки, описанные выше.

После прерывания, когда дочерний процесс уже завершён:

```powershell
node scripts/v1-collection.mjs details-recover $taskCollection $taskCollectionSha $taskUnionSha
```

Восстановление использует только полный сохранённый capture, повторно проверенный исходным verifier. При наличии failed-result создаётся отдельный `recovery.json` со ссылкой на SHA ошибки; первоначальная ошибка не переписывается. Без полного manifest восстановление отклоняется и новые пакеты блокируются до разбора. Автоматического HTTP-повтора не происходит. Общий timeout дочерней команды — пять минут; при его срабатывании действуют те же правила восстановления.

`sourceIneligible`/`failedFetches` — число непригодных исходных ответов, а не технически потерянных пакетов. Такие строки сохраняются в полном наборе и уменьшают последующее покрытие; их нельзя убрать для улучшения результата. `inventoryComplete:true` означает лишь наличие всех проверенных пакетов. `readyForEvaluation:false` и пустая вероятность сохраняются даже при полном комплекте.

Когда `missing` пуст:

```powershell
node scripts/v1-collection.mjs details-export $taskCollection $taskCollectionSha $taskUnionSha
```

Экспорт повторно проверяет все source receipts и создаёт новую версию `exports/<id>/evidence.json` с путями и SHA конфигурации, union и **всех** обязательных пакетов. Подмена receipt, пропуск пакета или новый discovery отклоняют экспорт. Предыдущие экспорты остаются на месте. Это объект `ResearchEvidenceFiles`, ещё не полный execution config.

## Граница текущего среза

Реализованы metadata discovery и управляемый учёт detail batches. Реализован [S3-01/V1-evaluation/collection/import](S3_01_V1_IMPORT_COLLECTION.md): импорт проверенных capture bytes штатным импортёром, учёт результата каждого пакета и сверка с canonical identities/series/outcomes, подготовка итоговых ссылок для execution config. Источники до snapshot, реальные coverage и независимая оценка остаются обязательными. Родительская задача `collection` не закрыта; модель не активирована.

Проверки и preservation зафиксированы в [evidence](evidence/s3-01-v1-managed-discovery.json) и PROGRESS. Синтетические тесты orchestration не являются эмпирической проверкой полноты будущего API.


QA: frozen offline install, typecheck/build,825 unit/CLI и85 Node-тестов (11 новых) — PASS. Проверка настоящей конфигурации до окна:0 API/0 попыток; модель/БД/232 файла bundle сохранены. Первый общий прогон завершился ошибкой тестового процесса с обрезанным PowerShell stderr; полный итоговый повтор прошёл. PG integration/Chromium/Python/Docker/Linux повторно не запускались.


QA среза details: frozen offline install/typecheck/build,826 unit/CLI и97 Node (12 новых), включая отдельный новый CLI-тест настоящего verifier на синтетических receipts — PASS. Рабочая конфигурация:4 offline команды,0 HTTP/0 попыток/0 detail plans; полный live capture не выполнялся.75 таблиц и очередь/44 SQL/232 bundle files/150 original modules сохранены. [Evidence details](evidence/s3-01-v1-managed-details.json). PG integration/Chromium/Python/Docker/Linux не запускались. Срез collection/import выполнен следующим checkpoint; текущий шаг — реальный **collection** по зарегистрированному окну. Модель и родительский release gate остаются открытыми.
