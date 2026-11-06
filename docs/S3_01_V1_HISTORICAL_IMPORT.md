# S3-01/V1-historical/canonical-import

Продолжение [сбора исторических источников](S3_01_V1_HISTORICAL_COLLECTION.md). Этот этап переносит сохранённые реальные ответы в canonical БД, подтверждает числовые аккаунты и серии, затем проверяет пригодность через существующий OutcomeVerifier. Elo, метрики качества и вероятности здесь не рассчитываются.

## Границы и порядок

`scripts/import-v1-historical.mjs` использует штатные `IngestionService`, `IdentityProvisioner`, `SeriesProvisionRepository` и `V1DataRepository`. Новых SQL-миграций и сетевого fallback в importer нет. `prepare` связывает конфигурацию, весь inventory records/attempts и справочники по SHA, воспроизводит исходный discovery/exposure review, проверяет endpoint/часы/hash источников. Каждый последующий этап заново проверяет план. Нельзя незаметно удалить непригодную карту или подменить source receipt.

1. Подготовить неизменяемый план по сохранённой коллекции и источникам numeric identities.
2. Подтвердить недостающие аккаунты по `/proPlayers` либо точному `/players/{account_id}` с проверкой Steam64 арифметики. Ники — подписи; совпадение ника не объединяет людей. Существующая verified связь сохраняется; конфликт останавливает связывание этого аккаунта. `known_at` текущего доказательства не переносится к дате исторического матча.
3. Импортировать все пригодные для штатного normalizer ответы, в том числе карты с пока неизвестной canonical серией. Статус accepted/partial импорта не заменяет отдельную проверку допуска модели.
4. Проверить серии по canonical maps, сохранённым receipts, native sides, лиге, `series_type` и OutcomeVerifier. Непригодные группы получают явные причины; победитель серии не выводится из одной карты.
5. Повторить импорт тех же ответов для привязки созданных серий; затем ещё один проход проверяет идемпотентность.
6. Экспортировать immutable dataset и отдельный отчёт покрытия. Данные рабочей БД вне исходного snapshot/inventory, иной history window или другой receipt SHA отклоняются. Только более ранние завершённые canonical-eligible карты попадают в счётчик истории. Серия с непригодной картой целиком неготова; исходные 145 кандидатов сохраняются в знаменателе.

Каждая карта/связь записывается отдельной штатной транзакцией. До запуска создаётся новый каталог, затем сохраняются отдельные receipts и итог. При прерывании уже записанные данные не отменяются и не удаляются: тот же план можно повторить в **новом** каталоге. Состояние БД перепроверяется перед применением; fingerprint защищает от устаревших identity/series preview. Общий worker и ранее ожидающее team-history задание для этого не нужны.

## Постраничный экспорт provenance

Найден и воспроизведён на отдельной тестовой БД реальный предел: старый экспорт отклонял более 20 000 `match_field_observations`; до импорта рабочая БД уже содержала 18 769. Чтение теперь идёт страницами по числовому bigint ID внутри одного repeatable-read snapshot, сохраняя `fetched_at <= snapshotAt` и все прежние часы. Количество строк не обрезается: есть явный общий предел 250 000, после которого экспорт отклоняется. Контракты max 5000 maps и max 2000 facts/map не изменены.

Тест на 20 020 пригодных по времени записей плюс одну будущую сначала воспроизвёл прежний отказ, затем проверил полный результат, исключение будущей записи, точный повтор и отсутствие записи в БД. При реализации также исправлена сортировка: `ORDER BY` явно ссылается на числовую колонку таблицы, а не текстовый alias `id::text`.

Это меняет текущий `packages/db/dist/v1-data-repository.js`; в `v1-runtime-code` новый модуль страниц также включён в обязательные зависимости. Старый frozen executable bundle и исходные E0/E1/V1 artifacts сохранены, но **текущий runtime уже не соответствует старому executable freeze**. Проверка совместимости остаётся строгой и возвращает false; тест подтверждает отказ старого freeze и контроль изменений кода/exports/runtime. Для исторического теста нужен новый отдельный freeze до первого scoring; менять старые SHA или ослаблять compatibility gate нельзя. Этот этап не регистрирует и не активирует модель.

## Команды для локального плана

После сборки, из корня проекта:

```powershell
$plan = '.tools/v1-historical-import-20261106/plan.json'
$planSha = '95669a756978fef81bf0a2200de4c1699fbccf07c3cde69da3a3b2aa0d649255'

# Каждый output directory должен быть новым; повтор данных идемпотентен.
node scripts/import-v1-historical.mjs verify $plan $planSha .tools/historical-import-verify-new
node --env-file-if-exists=.env scripts/import-v1-historical.mjs identities $plan $planSha .tools/historical-identities-new
node --env-file-if-exists=.env scripts/import-v1-historical.mjs maps $plan $planSha .tools/historical-maps-new
node --env-file-if-exists=.env scripts/import-v1-historical.mjs series $plan $planSha .tools/historical-series-new
node --env-file-if-exists=.env scripts/import-v1-historical.mjs maps $plan $planSha .tools/historical-linked-maps-new
node --env-file-if-exists=.env scripts/import-v1-historical.mjs export $plan $planSha .tools/historical-export-new
```

Исходный config: `.tools/v1-historical-import-20261106/config.json`, SHA `6efb4721dd0fda8326be05a3e5914927043a9eebdd14182be58331b3d2c9d7de`. Для нового проверяемого плана: `prepare CONFIG SHA NEW_PLAN`. Raw bodies, account proofs, промежуточные preview и dataset с метками остаются локально в игнорируемой `.tools`; git checkout без этих файлов не воспроизводит live evidence.

Следующий этап — **S3-01/V1-historical/executable-freeze**: привязать точный canonical dataset, fixed Elo и новый исторический протокол к отдельному executor/evaluator/registry формату до первого расчёта тестовых метрик. Числовые пороги и параметры модели остаются прежними; не выбирать варианты по результатам test.

## Фактические данные 6 ноября 2026

Импортированы 599 новых реальных карт; рабочий inventory вырос с 340 до **939**, сохранены 45 031 field observations. Созданы 188 players/account proofs/aliases по числовым доказательствам; 193 прежних verified аккаунта переиспользованы. Все 381 участник связан без nickname matching. Для 138 недостающих связей использован ранее сохранённый `/proPlayers`; ещё 50 точных профилей получены через общий quota client: 50 HTTP200, без retries. Пять аккаунтов без нового proof в подготовленном плане уже имели verified canonical links и не потребовали дополнительных запросов.

Проверены и созданы 273 серии. Первый проход принял 599 карт; после series provision повтор связал 595 карт, четыре уже были идемпотентны. Финальный повтор вернул **599 duplicate**, с теми же receipt IDs/data revisions и без изменения всех **83 public-таблиц**. Очередь сохранена, общий worker не запускался.

Canonical export содержит **899 пригодных карт истории**. Из фиксированных 145 test targets / 60 series у 143 карт подтверждены исход, аккаунты и минимум пять более ранних пригодных карт на каждого игрока. После проверки целых серий готово **140 карт / 58 серий** — 96,55% исходного map denominator. Минимумы 100 карт, 40 серий и 80% покрытия (116/145) выполнены на уровне данных. Это **не** пройденный quality gate: Brier/log loss/calibration и вероятность не рассчитывались, модель не активировалась.

Пять неготовых targets остаются в знаменателе: две недоступные карты `9010993339` и `9011023151`, а также три известных соседа их серий `1145377` / `1145411`. Нельзя удалить их ради улучшения coverage. Исходные 116 exposure-excluded карт по-прежнему вне теста; ограничение 10 ранних карт на аккаунт и неизвестная полнота внешнего источника сохраняются.

Dataset: `.tools/v1-historical-import-20261106/export-01/dataset.json`, SHA `6396235552a52691b7611e35c0900ee70eaae139ea07370b89cf561212b53045`, fingerprint `d6fbae61b67341bb7627afb374216e1bd28c258f52c5029ba35e2ed53fbd8e0b`. Отдельный coverage report повторно восстановлен из этого файла и совпал полностью. Это сохраняемый результат подготовки данных, **ещё не исторический executable freeze**.

[Итоговый checkpoint](evidence/s3-01-v1-historical-import.json): 892 уникальных unit/CLI cases с целевым повтором обновлённого guard, полный набор 160 Node tests и 68 PostgreSQL cases — PASS; frozen install/typecheck/build/final DB build также PASS. Первоначальные сбои и способ объединения результатов записаны в PROGRESS/evidence; единый полностью зелёный recursive unit run не заявляется. 49 SQL и 245 protected artifacts/archived bundle сохранены. API и idle history-only worker обновлены; health ok, Web HTTP200, pending team-history и models/forecasts не изменены. UI/browser/Python/Docker/Linux suites для этого среза не повторялись.
