# S1-08 — офлайн-диагностика патчей корпуса

`patch:diagnose` воспроизводит сопоставление карт, числовых кодов OpenDota и записей Valve по сохранённым снимкам. Входы проверяются Zod и SHA-256. Отчёт содержит причины конфликтов и неизвестных значений; повтор с теми же данными даёт те же bytes/fingerprint. CLI не требует DATABASE_URL и не вызывает сеть.

```powershell
pnpm install --frozen-lockfile
pnpm patch:diagnose docs/evidence/s1-08-patch-diagnostics-config.json .tools/new-patch-diagnostics.json
```

Выходной файл должен быть новым. Публичный config ссылается на имеющиеся audit snapshots и локальные файлы `.tools`; для exact replay нужны эти файлы. Их SHA и происхождение указаны в [manifest](evidence/s1-08-patch-diagnostics.json). [Реальный отчёт](evidence/s1-08-patch-diagnostics-report.json) сохранён отдельно; его fingerprint относится к содержимому отчёта без поля fingerprint, а не к bytes JSON-файла.

## Входной контракт

`PatchDiagnosticsConfigSchema` содержит:

- `schemaVersion: 1`, `snapshotAt`: явный UTC timestamp с миллисекундами;
- `mapCaptures`: 1–40 ссылок `{path, sha256}` на существующие OpenDota audit v3 snapshots, до 50 observations каждый;
- `providerPatches`: ссылка на raw `odota/dotaconstants/build/patch.json`, дополненная `fetchedAt`, pinned `revision` (40 hex) и точным GitHub/raw source URL этой revision;
- `valveList`: ссылка на `{data, source}`, возвращаемое `ValvePatchClient.getPatchList()`;
- необязательный `matchIds`: явный список уникальных decimal-string ID; отсутствие выбранной карты завершает проверку ошибкой.

Пути разрешаются относительно config. Идентификаторы карт больше JS safe integer остаются строками. Source code 0 поддерживается. Внешние даты OpenDota принимаются с точностью секунды или миллисекунды, нормализуются в UTC с миллисекундами. Порядок/ID строк справочника должны соответствовать source index; совпадающие или убывающие даты блокируют ввод вместо неявной сортировки.

Максимум: config 64KiB, один snapshot 8MiB, суммарно 64MiB. Чтение ограничено размером файла и проверяет его изменение во время чтения; источники должны быть корректным UTF-8. Snapshot SHA проверяется до разбора JSON. Источники/генерация capture после snapshotAt, источник после declared capture generation и карта после capture generation завершают проверку ошибкой. Все входные snapshots проверяются до применения match selection.

## Значения отчёта

| Поле карты | Значение |
|---|---|
| observedProviderCodes / providerCode | Наблюдённые коды; единственный согласованный код либо null |
| providerCoarseLabel | Название из source dictionary при согласованном коде/времени |
| recomputedProviderCode | Диагностическое повторение индекса по датам справочника |
| latestPublishedFeedLabel / Timestamp | Последняя запись Valve по заявленной дате до startedAt |
| nominalBoundedCandidate | Кандидат из закрытого номинального feed interval существующего auditor |
| verifiedPatchId / historicalKnownAt | Всегда null в этом инструменте |

Название latestPublishedFeedLabel не доказывает, что нынешнее содержимое feed было доступно на момент старой карты. Timestamp feed не заменяет Steam publication, effective release или historical knownAt. Коды OpenDota не различают буквенные обновления внутри наблюдаемой базовой версии. [Проверка первичных источников](S1_08_PATCH60_SOURCE_AUDIT.md).

Повторные observations объединяются по match ID: `uniqueMaps` считает каждую карту один раз, `duplicateObservations` показывает дополнительные наблюдения. Конфликтующие коды или starts не разрешаются последним snapshot. Unknown code не подменяется вычисленным индексом; частично отсутствующие коды помечаются отдельно. Для неподтверждённого pro status метки карты не назначаются. Совпавшие даты разных Valve labels дают unknown/`VALVE_FEED_BOUNDARY_AMBIGUOUS`.

SHA доказывает неизменность переданного artifact, но не истинность его утверждений о source. `rawValvePayloadHashVerified:false`: source payload SHA относится к исходным HTTP bytes, из schema projection они не восстанавливаются. Отчёт всегда имеет `evidenceScope:source_diagnostics_only`, databaseWrites/networkRequests 0, autoRegistryEligible/trainingReady/deployable false. Загрузка пользовательского snapshot не становится приёмом evidence в canonical registry.

## Проверка на реальном корпусе

Использованы шесть сохранённых live audits: четыре исторические лиги S1-08, S1-13 и S1-21. Новых запросов к провайдерам не было. **40 observations → 36 unique pro maps, 4 duplicate observations**. В словаре разрешены все 36 coarse labels; verified patch maps 0.

| Provider code / coarse label | Последняя запись Valve по declared timestamp | Закрытый nominal candidate | N карт |
|---|---|---|---:|
| 48 / 7.29 | 7.29d | 7.29d | 3 |
| 49 / 7.30 | 7.30d | 7.30d | 2 |
| 51 / 7.32 | 7.32c | 7.32c | 5 |
| 53 / 7.34 | 7.34d | 7.34d | 5 |
| 56 / 7.37 | 7.37c | 7.37c | 5 |
| 60 / 7.41 | 7.41f | null, открытый интервал | 16 |

Два запуска дали побайтно одинаковые отчёты. Config перестановок/других путей к тем же bytes не меняет fingerprint. Итоговые версии здесь диагностические; canonical patches и обучающая пригодность не повысились. Содержимое 21 рабочей таблицы сверяется с предыдущим snapshot, миграции 001–022 сохранены. В manifest записаны реально исполненные checks и SHA логов.

## Ошибки и тесты

В stderr возвращается JSON `{status:'error', code, message}` с русским message. SHA mismatch, неизвестный выбор карт, конфликт timeline, превышение лимита и существующий output дают ненулевой exit. Output создаётся через exclusive handle после проверки inputs; повтор не перезаписывает предыдущий файл. Тексты payload/исключений transport и env credentials не выводятся.

13 новых pure tests покрывают границы, native dates, дубликаты/порядок, несовпадающие starts/коды, missing/unknown/partial, code0, tie Valve timestamps, source horizon, tampering и нулевой sample. 4 Node CLI tests проверяют byte replay, bigint IDs, отказ overwrite, повреждённый snapshot, size limit и horizon при недействующем DATABASE_URL. Синтетика помечена в tests и не использована как live evidence. Дополнительно проверяются существующие Valve tests и штатные frozen install/typecheck/test/build. Browser/Python/backtest/PG integration в этом срезе не запускались: runtime writer отсутствует, проверка БД выполнена отдельным read-only inventory.

## Следующая задача

**S1-07 — решение о достаточности доказательств интервала патча для 16 недавних карт.** Подготовить проверяемое решение по released_at/coverage_until/known_at с уже полученными первичными источниками, явно перечислить недостающие факты и возможный ограниченный контракт для неопределённых границ. Изменение нормативного контракта не следует автоматически из диагностического label. До такого решения registry и prediction gates сохраняются. Повторное создание аналогичных diagnostic helpers больше не требуется. Рекомендуемая модель: **GPT-6 Astra · High**, выбор владельцем вручную.
