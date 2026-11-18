# S3-04 — типизация оставшихся архивных ID

14 ноября 2026. Закрыта очередь **181 неоднозначного числового ID** из предыдущего [архивного разбора](S3_04_EXPOSURE_ARCHIVE_REVIEW.md): **168 native-карт Dota и 13 встреч PandaScore**, конфликтов и неразрешённых ID в этой очереди нет. Это список ранее просмотренных данных для исключения из независимой проверки, а не новый обучающий корпус.

Расширенный реестр: **5674 карты / 1744 серии**, 3348 записей происхождения, 1096 прежних local aliases. Добавлены 168 карт и одна явно указанная серия OpenDota. У **1954 карт** связь с серией OpenDota неизвестна; это отдельная нерешённая задача, не противоречащая установлению типа ID.

## Основания

| Сохранённый источник | Новые native-карты | Проверка |
|---|---:|---|
| Valve league 16935 | 106 | Исходные bytes, SHA receipt, официальный endpoint и league_id |
| Valve league 17765 | 3 | Исходные bytes, SHA receipt, официальный endpoint и league_id |
| OpenDota player-history discovery | 27 | Native endpoint, lobby filter, pinned producer и нормализованные строки |
| Архив DB player-history-depth | 31 | Producer/source_audit, explorer и сохранённые discoveryRows |
| OpenDota league 20486, first row | 1 | Provider/endpoint/league_id и native поля карты/серии |

У трёх последних источников проверены сохранённые нормализованные данные и метаданные; отсутствующие оригинальные HTTP-тела **не объявлены повторно проверенными по SHA**. Из этого не следует профессиональная или временная пригодность карты для обучения.

13 встреч PandaScore подтверждены **37 ранее сохранёнными снимками расписания**, выгруженными read-only из локальной БД. Проверены SHA snapshot_text, provider/endpoint, source SHA, время получения/записи и providerMatchId. Размер числа или похожий ник не используются для определения пространства ID. Новых запросов к провайдерам нет.

Номера серий Valve сохранены отдельным evidence с provider=valve. Равенство числового номера не устанавливает тождество с OpenDota. Прежние источники, aliases и frozen-отчёты сохранены; новый отчёт привязан к трём родительским артефактам по SHA.

## Реализация и воспроизведение

- [exposure-namespace-core.mjs](../tools/research/exposure-namespace-core.mjs): чистые адаптеры, проверка источников, раздельные пространства имён и дедупликация карт.
- [exposure-namespace.mjs](../tools/research/exposure-namespace.mjs): план 13 источников, ограничения путей/объёма, exclusive capture и воспроизведение с внешним SHA и закреплённым кодом.
- [Pure tests](../tests/node/exposure-namespace.test.mjs) и [file tests](../tests/node/exposure-namespace-file.test.mjs): 13 новых проверок, включая совпадающие числа разных провайдеров, unsafe IDs, подмену файла/родителя/результата, неверный SHA и повторную запись.

```powershell
node tools/research/exposure-namespace.mjs verify .tools/s304-namespace-report-r1.json be55c46227c122aaf004e9595c644d5e41ba5e774154f95621efe65ea94b41d9
```

Финальный план: .tools/s304-namespace-plan-r1.json, SHA `4797660a027279707d3f6ac72faefb54d6aa8e4de3f954901499e2b620ab45fd`. Старые reports не переписаны. В этой задаче заново сверены SHA родителей; полный старый обход 13760 файлов не повторялся.

## Проверки и ограничения

Новый replay и независимое объединение ID прямо из полей источников прошли: 168/13/5674. **72 Node-теста, включая 13 новых, прошли**, 61 migration checksum сохранён. Проверка БД в 20:10:02 UTC: V1 model_eligible, 2260 карт, семь прежних forecast hashes и все миграции сохранены; API/Web200, private401. Сейчас в БД восемь prediction_runs; проверка подтверждает сохранность семи ранее закреплённых записей, а не отсутствие других пользовательских расчётов.

**1053 пакетных теста, frozen offline install, typecheck и build — PASS (exit 0).** Ссылки документации и git diff --check прошли; восемь прежних code-hash bindings совпали. Существующие предупреждения сборки Zod/chunk size сохранены. Подробности — в [evidence](evidence/s3-04-reference-namespace-resolution.json). Отдельные PG integration/browser/Python suites не запускались: API/UI/SQL/числа модели не менялись. Рабочая БД использовалась только на чтение; обучение, активация и перезапуск не выполнялись.

**referenceNamespaceComplete=true относится только к очереди 181 ID.** Полнота глобального реестра не удостоверена. В прежних 131 requires_review файлах ещё нужно классифицировать ограничения формата/объёма, текст и связи серий; число оставшихся таких файлов заново не пересчитывалось. UTC начала управления героями также остаётся неподтверждённой. registrationAllowed/collectionAllowed/deployable=false; допуска модели после драфта эта задача не даёт.

**Следующий срез: S3-04/post-draft-validation-readiness/exposure-ledger/coverage-and-series-audit** — свести оставшиеся пробелы архивного охвата и проверить связи Valve/OpenDota на уже сохранённых свидетельствах; подготовить явный список непокрытых случаев для выбора независимой выборки. Без новых API-запросов и подмены неизвестной серии предположением. **GPT-6 Astra · High.**


**Продолжение 15 ноября — coverage-and-series-audit:** [131 остаточный файл и155Valve groups](S3_04_EXPOSURE_COVERAGE_AND_SERIES.md):74accounted/2Unauthorized/55review;14UTF16 и3large datasets разобраны.24новых явных OpenDota series_id требуют проверки provenance; ledger5674/1744 пока не изменён. **Текущий следующий срез: exposure-ledger/series-projection-reconciliation. GPT-6 Astra · High.** Глобальный охват/clock/registration/collection/deployable не объявлены пройденными.
