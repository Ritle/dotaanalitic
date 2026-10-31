# S3-01 — исторические лиги и наблюдаемый корпус

**2026-11-01 (Europe/Moscow).** Получены **40 новых detailed maps** из пяти non-TI лиг разных периодов и **1240 уникальных discovery rows** этих лиг. Это расширение source audit, а не готовый тренировочный корпус. Все 56 HTTP attempts завершились 200; transport errors/retries отсутствуют. Capture UTC: 2026-10-31T21:39:55.376Z → 21:41:50.857Z. [Manifest с SHA, кодом и источниками](evidence/s3-01-source-manifest.json), [полный минимальный discovery projection](evidence/s3-01-league-discovery.json).

## Метод отбора

Пять лиг выбраны заранее из текущего `/leagues` с tier professional/premium, чтобы дополнить прежние TI 2021–2024 другими турнирами и годами. Из каждой `/leagues/{id}/matches` существующий audit schema3 выбирает 8 равномерных рангов после сортировки start_time → bigint match_id, включая первую/последнюю карту. Качество ответов не использовалось для замены выбранных IDs.

Отдельно сохранены **все строки, возвращённые** пятью league endpoints, с девятью типизированными nullable полями: match_id, start_time, duration, radiant_win, radiant_team_id, dire_team_id, leagueid, series_id, series_type. Это discovery values из источника, не canonical labels OutcomeVerifier. Полнота endpoint относительно всей реально сыгранной лиги и каждой серии остаётся **unknown**: полученный список не доказывает отсутствие пропущенных карт. Source hash/fetch time и request counters сохранены отдельно для каждой загрузки.

## Detailed sample

| Лига / capture | Даты выбранных карт UTC | Discovery rows | Detailed N | Provider patch codes (N) | Known series |
|---|---|---:|---:|---|---:|
| [4554 — ESL One Frankfurt 2016](evidence/s3-01-live-frankfurt2016.json) | 2016-04-04 — 2016-11-18 |232|8|16(3),17(2),18(3)|7|
| [9880 — ESL One Birmingham 2018](evidence/s3-01-live-birmingham2018.json) | 2018-04-20 — 2018-05-27 |108|8|32(4),34(3),35(1)|7|
| [12245 — OMEGA League](evidence/s3-01-live-omega.json) | 2020-08-01 — 2020-09-06 |510|8|46(8)|8|
| [15196 — DreamLeague 19](evidence/s3-01-live-dreamleague19.json) | 2023-04-09 — 2023-04-23 |194|8|51(7),52(1)|8|
| [17765 — DreamLeague 25](evidence/s3-01-live-dreamleague25.json) | 2025-02-16 — 2025-03-04 |196|8|56(4),57(4)|8|

Во всех 40 selected responses согласованы ID/лига, имеется completed outcome, две разные организации, 10 native slots, 10 различных source Steam32 accounts, 10 финальных героев, 10 picks и structural consistency. Current league catalog относит все 40 к professional/premium. Integer lane_role hints имеются 40/40. **Series ID присутствует 38/40:** отсутствует у 2272572379 и 3908954812. Наблюдаются 11 provider patch codes; их нельзя превращать в verified release registry.

**Canonical identity, verified patch, lineup known-at, post-draft heroes known-at и strict draft-order validity не оценены**: denominator 0, ratio null на всех 40. Полные финальные составы/герои и корректная форма draft events не доказывают историческую доступность до начала карты, canonical identity или проверку исторических draft rules. Lane_role не становится Pos 1–5.

Название лиги не устанавливает scope главного турнира: в частности, 4554 содержит карты с апреля по ноябрь 2016. Это наблюдаемая привязка API, не доказательство, что все 232 карты относятся к основной стадии Frankfurt. Равномерная выборка крупных именованных лиг не репрезентативна для всех pro-матчей, тиров и регионов.

## Discovery и series inventory

| League ID | Unique map IDs | Provider series groups | Maps без series | Maps без обеих команд |
|---|---:|---:|---:|---:|
|4554|232|89|9|4|
|9880|108|38|9|0|
|12245|510|222|0|0|
|15196|194|93|0|0|
|17765|196|94|0|0|
|Всего|1240|536|18|4|

Все 1240 discovery rows содержат boolean winner; это ещё не verified label. Повторных map IDs, несовпадений requested league и наблюдаемых противоречий unordered team pair внутри 536 provider series groups в этом capture не найдено. Это структурная проверка доступного списка. **39 групп содержат только одну наблюдённую карту**; это не доказательство BO1 или полной серии. Group-size distribution и ID пропусков сохранены в manifest. Неизвестный series ID не объединяется в общую «серию 0» и не угадывается по соседним датам.

Detailed 40 входят в discovery 1240; их нельзя складывать в 1280 наблюдений. Источники discovery и details получены отдельными запросами с отдельными SHA. Повторный ответ может измениться; сведения не считаются автоматически одинаковыми или canonical только потому, что match_id совпал.

## Прежние captures и воспроизведение

[S0-08](S0_08_SOURCE_AUDIT.md) хранит 40 detailed observations; [S3-00](S3_00_SOURCE_AUDIT.md) добавил 10 observations, из них 3 ID пересекаются. Это 47 уникальных IDs. Новые 40 не пересекаются с этими 47: объединение содержит 87 уникальных detailed IDs из 90 наблюдений. Это только cardinality после dedupe, **не объединённый coverage benchmark, training N или accuracy**. Прежние bytes и manifests не изменены, SHA проверены.

После shared build и настройки DATABASE_URL можно создать новые отдельные captures:

```powershell
node --env-file-if-exists=.env scripts/audit-prediction-sources.mjs --league 4554 --sample 8 --out reports/s3-01-new-frankfurt2016.json
node --env-file-if-exists=.env scripts/audit-prediction-sources.mjs --league 9880 --sample 8 --out reports/s3-01-new-birmingham2018.json
node --env-file-if-exists=.env scripts/audit-prediction-sources.mjs --league 12245 --sample 8 --out reports/s3-01-new-omega.json
node --env-file-if-exists=.env scripts/audit-prediction-sources.mjs --league 15196 --sample 8 --out reports/s3-01-new-dreamleague19.json
node --env-file-if-exists=.env scripts/audit-prediction-sources.mjs --league 17765 --sample 8 --out reports/s3-01-new-dreamleague25.json
```

Фактический бюджет: 50 attempts пяти audit CLI, 5 дополнительных league discovery reads, 1 catalog selection read. Каждый запрос использовал существующий OpenDota client с PostgreSQL quota, timeout, retry/Retry-After; ограничения не обходились. Код клиента/схем/аудитора и runtime SHA сохранены. Полные raw payloads, source account IDs, профили и ключи в файлы не записывались. Использован персональный документированный API scope из [DATA_SOURCES](DATA_SOURCES.md).

Проверки SHA всех новых/прежних captures, код/runtime hashes, shape discovery, unique IDs, HTTP totals и unassessed/null semantics выполнены. Изменялись только provider quota counters. Canonical maps, identities, patch/context proofs, datasets и models не импортировались. **S1-07 и пригодность широкого исторического корпуса для обучения этим аудитом не закрыты.**
