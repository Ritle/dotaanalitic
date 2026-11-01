# S1-08 — значение patch code 60 и источники Valve

Проверка 2026-11-01 установила: **OpenDota code 60 обозначает базовую версию 7.41, но не различает её буквенные обновления**. Последняя опубликованная запись в полученном списке Valve — **7.41f**. Для всех 16 выбранных карт она предшествует startedAt по timestamp feed. Это два разных диагностических факта; ни один не назначает verified canonical patch карте. [Manifest и проекция](evidence/s1-08-patch60-source-audit.json).

## Что проверено у OpenDota

В [закреплённом dotaconstants patch.json](https://github.com/odota/dotaconstants/blob/5c0242df9057848fa2036ca3fafe9f2bd4508163/build/patch.json) есть запись id 60 / name 7.41 / date 2026-03-24T00:50:59.580Z. Всего 61 запись; 60 — последний индекс. Для этой версии отдельных записей 7.41a–7.41f нет.

[Закреплённый OpenDota compute.ts](https://github.com/odota/core/blob/8d774abda8542390fbd215487d961f1b5c3a3ef3/svc/util/compute.ts) присваивает `pm.patch` через `getPatchIndex(pm.start_time)`: перебирает даты справочника, выбирает предыдущий индекс перед следующей датой, а после последней даты возвращает последний индекс. Это вычисляемое поле по времени и справочнику, **не независимое измерение версии игровым сервером**. `dev/repatch.ts` использует тот же механизм для служебного backfill. Удалённый код не выполнялся; алгоритм прочитан и отдельно воспроизведён на сохранённых starts.

Все 16 persisted pro maps из [предыдущего inventory](S1_08_PATCH_CONTEXT_INVENTORY.md) вновь дали индекс 60. Пин фиксирует прочитанную версию исходников, но не доказывает точный deployed commit API OpenDota на момент прежнего capture. Сами source receipts с кодом 60 не изменены. Числовой индекс не подставляется вместо внутреннего `patch_id`.

## Что получено от Valve

Использован существующий `ValvePatchClient`: [официальный список](https://www.dota2.com/datafeed/patchnoteslist?language=english), notes и ограниченные Steam announcement pages для базовой 7.41, предыдущей 7.41e и последней 7.41f. Выбор не зависел от результатов карт. Источники возвратили HTTP200, schema и source IDs проверены клиентом.

| Версия | Timestamp list/notes, UTC | Публикация Steam, UTC | Разница |
|---|---|---|---:|
| 7.41 | 2026-03-24 07:00:00 | 2026-03-24 23:43:44 | 60224 с |
| 7.41e | 2026-07-30 07:00:00 | 2026-07-30 23:58:15 | 61095 с |
| 7.41f | 2026-09-15 07:00:00 | 2026-09-15 18:44:25 | 42265 с |

Notes: [7.41](https://www.dota2.com/datafeed/patchnotes?language=english&version=7.41), [7.41e](https://www.dota2.com/datafeed/patchnotes?language=english&version=7.41e), [7.41f](https://www.dota2.com/datafeed/patchnotes?language=english&version=7.41f). Точные Steam API URLs, news IDs, fetchedAt и payload SHA находятся в manifest. Число hero rows — 126/57/35 соответственно; оно не означает verified impact или eligibility героев.

Дата dotaconstants для 7.41 также отличается от обоих первичных timestamps. Ни минимальное, ни максимальное значение не выбрано как фактическая секунда установки обновления. `comparePatchSources` сохранил `verifiedReleasedAt`, `coverageUntil`, `knownAt` null для всех трёх сравнений.

Последняя запись Valve 7.41f не имеет следующей границы в полученном feed. Поэтому штатный `assessAuditedMapPatches` для всех 16 карт возвращает `FEED_INTERVAL_OPEN_OR_UNKNOWN`, nominal bounded candidate null, verifiedPatchId null. Отдельная диагностическая проекция `latestPublishedFeedLabel: 7.41f` сообщает только последнюю опубликованную запись до даты карты. Она не переименовывает результат resolver и не доказывает отсутствие неперечисленных изменений между публикацией и картой.

## Решение по применению

- **Можно сохранить:** provenance и диагностические сведения `source code 60 / coarse label 7.41`, отдельно `latest published feed label 7.41f` с его timestamp, fetchedAt и SHA.
- **Нельзя автоматически записать в canonical registry:** release/coverage/knownAt, hero availability/impact или patch_id карт. Источники не удовлетворяют действующему контракту доказательств этих полей.
- **Не требуется повторять:** определение code60 и поиск уже проверенного архивного body7.34d. Повторный такой же запрос не создаст недостающее historical availability evidence.

Запись в БД не выполнялась. 21 таблица совпала с inventory до аудита, SQL001–022 совпали с applied SHA, golden001–005 неизменны. Maps36/series28/players165/receipts155/assessments114, registry revision0, datasets0/active models0 сохранены. Patch/source audit не устраняет отдельный pre-start lineup gate и не разрешает обучение или проценты побед.

## Воспроизводимость и проверки

Capture состоит из **14 фактических GET/14 HTTP200**: 7 GitHub (два refs, pinned constants, дерево core и три code files) и 7 Valve (list + три notes + три announcement pages). Автопагинации и повторов не было. Для GitHub fixed-host helper использует timeout20s, limit4MB, pacing не менее1100ms между запросами одного run; Valve использует существующие timeout/size/schema/Retry-After boundaries, attempts1 и конечный budget. Веб-просмотр документации отдельно не является частью этого HTTP capture. Полные parsed Valve captures и GitHub bytes остаются ignored в `.tools/s1-08-patch60-*`.

Source SHA Valve — hash исходного HTTP body, вычисленный клиентом; клиент сохраняет нормализованную schema projection, поэтому этот hash нельзя пересчитать из повторно сериализованного parsed JSON. Artifact SHA отдельно связывает сохранённые файлы. GitHub bytes сохранены полностью и проверяются напрямую. Не утверждать exact raw Valve replay из parsed projection.

В отчёт включены SHA источников, pinned revisions, 16 match IDs/start times, повторное вычисление индекса, результат существующего pure auditor, список неизменённых таблиц и логи проверок. Production код, SQL, зависимости и UI не менялись. Frozen install/typecheck/unit/build и выбранные PostgreSQL checks исполнены; окончательные числа приведены в manifest. Browser/Python/backtest не запускались; API/web/worker не перезапускались.

## Следующий шаг

**S1-08 — воспроизводимый read-only CLI диагностики версии корпуса.** Заменить одноразовое сопоставление проверяемым контрактом входных snapshots/SHA и отчётом, который раздельно показывает provider code/coarse label, последнюю опубликованную запись Valve и nullable verified patch. Использовать существующие patch client/auditor boundaries; покрыть конфликтующие даты/коды, неизвестный код, открытый интервал, дубликаты карт и повторный запуск. Никаких записей в registry, выводов об historical knownAt или изменения prediction gates. Этот срез делает установленное ограничение проверяемым при следующем импорте; сам по себе он не закрывает S1-07/S3-01 или broad corpus gate. Рекомендуемая модель: **GPT-6.1 Sol · High**, выбор владельцем вручную.


Продолжение2026-11-01: описанный CLI реализован и проверен на всех36 картах. [Запуск, форматы, тесты и следующий S1-07 gate](S1_08_PATCH_DIAGNOSTICS_CLI.md).
