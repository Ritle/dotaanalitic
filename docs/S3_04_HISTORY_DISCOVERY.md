# S3-04 — первый поиск недостающей pro-истории

13 ноября2026. Выполнен [подготовленный план](S3_04_HISTORY_GAP_AUDIT.md) для первой группы20аккаунтов. **9запросов/9HTTP200,192строки участия,97уникальных карт-кандидатов**,95отсутствуют в frozen capture. Импорта, обучения и активации не было.

## Фиксация до запросов

Manifest зарегистрирован 2026-11-12T23:39:59.976Z, запуск начат 2026-11-12T23:40:25.174Z. В нём закреплены proposal/audit/capture SHA, точные9query scopes, код/тесты/скомпилированные зависимости, Node version, quota limits и24h cache policy. Запросы выполнялись прежним `OpenDotaPlayerHistoryClient.discover`; source-known-at остаётся null, fetched-at — реальное время получения, не дата исторической карты.

Локальный лимит18HTTP attempts включает retries; по факту понадобилось9без повторов. Прежний PostgreSQL provider budget проверял каждое обращение и учитывал rate-limit headers. Квоты не сбрасывались. Дополнительных detail/profile/league/hero запросов не было; exact-query свежий cache проверялся, cache hits0. Не запускались фоновые jobs и не менялись рабочие match/model/scenario строки.

[Evidence](evidence/s3-04-history-discovery.json) содержит контрольные суммы; полные immutable manifest/attempt/response/query/report файлы находятся в `.tools/s304-history-discovery-r1`. Raw body сохраняется только для прошедшего валидацию ответа; ошибочный/невалидный body не записывается, сохраняются безопасный код и статус. Это не журнал секретных HTTP headers.

## Полученные данные

| Account ID | Строк участия | Достигнут лимит10 |
|---|---:|---|
|164047347|10|да|
|188351504|10|да|
|450454900|10|да|
|892486081|10|да|
|860145568|10|да|
|331711578|10|да|
|389276156|10|да|
|480210721|10|да|
|120840516|10|да|
|127530803|10|да|
|312542697|10|да|
|1220993352|10|да|
|1150772339|10|да|
|194555122|10|да|
|482364904|10|да|
|169516760|10|да|
|333700720|10|да|
|24045849|10|да|
|28229163|2|нет|
|36162063|10|да|

У19аккаунтов страница заполнена: более глубокая история может существовать. У28229163 вернулись2строки; это не утверждение, что у игрока всего2профессиональные карты. Фильтр ограничен730днями, источником и доступностью его данных; более ранний warmup2024 полностью не покрыт. Остальные14аккаунтов исходного аудита не запрашивались.

Все192строки сохранены; общий dedup по bigint match ID даёт97карт. Одинаковая карта для нескольких аккаунтов не увеличивает число тренировочных примеров и не должна повторно скачиваться. Проверены account/slot/time/window/source-tier поля и отсутствие конфликтов времени, длительности, league ID, исхода и slot среди повторных наблюдений. Конфликтов0. Это согласованность discovery, **не независимая верификация результатов**.

### Что означает95новых карт

95ID — новые относительно замороженного capture, не автоматически95готовых примеров. Для каждой ещё нужны детали, идентичности десяти участников, actual sides, series/outcome eligibility и strict completed-before-target проверка. `professional/premium` в Explorer не означает Tier1. Не все строки обязательно войдут в модель после проверки.

Два уже известных ID9036406856 и9040197051 тоже **не готовы**: в прежнем capture outcome unavailable / `TEAM_SIDES_UNKNOWN`. Наличие в локальной БД не равно пригодности. Сначала следует проверить сохранённые receipts; повторная загрузка сама по себе не гарантирует разрешение сторон. Не угадывать стороны по названию, порядку игроков или текущему составу.

Исходные175/223paired coverage, R1 insufficient/negative и active V1 не переоцениваются этим discovery. Модель не получает новые признаки или прогнозы из списка найденных ID.

## Инструмент и гарантии

`tools/research/post-draft-history-discovery.mjs`:

- `register` связывает существующий proposal с34-account audit и capture; код/зависимости проверяются до запуска.
- `run` создаёт immutable started marker до подключения/HTTP. Второй запуск существующего каталога запрещён; каждый query result и каждая попытка сохраняются отдельно. При недоступном источнике остаток явно not_attempted, rows=null; успешный пустой ответ имеет rows=0.
- Shared quota guard + глобальный18/per-query2 cap действуют до запроса. URL/метод фиксированы существующим query builder; запросы с изменённым scope отклоняются. При длинном Retry-After/исчерпании квоты сохраняется partial, ограничения не обходятся.
- Exact-query reference cache не старше24h можно читать без HTTP. Если cache хранит нормализованный JSON, его hash отделён от original payload SHA и помечен `normalized_reference_snapshot_not_original_bytes`; в этом запуске cache не использовался.
- `verify` работает offline: сверяет source/code/manifest/started, исходные raw-body SHA, записи попыток, дедупликацию и итоговый report. Кандидаты со спорными фактами сохраняются с конфликтом, не превращаются в verified history.

```powershell
node tools/research/post-draft-history-discovery.mjs verify .tools/s304-history-discovery-r1
```

Manifest SHA: `a46a34701935d309039f04bbc737399601bbd3a3f01a09d45eeb0bd10029e3ba`.
Report SHA: `e3782947f338d7a8afa91eb477f7ea959f372278c1bed95b9ec67df0a7bac53d`.

## Проверки

8целевых Node-тестов PASS: plan mutation/budget guards, bigint dedup,429/partial/unknown-vs-empty,full page,conflicting facts/slots,wrong accounts/non-pro/boundary completion,receipt SHA,record sequencing. CLI replay с недоступным DATABASE_URL PASS; повторrun отклонён до DB/HTTP, первые файлы неизменны. Независимо пересчитаны192rows/97unique и9HTTP200, проверен completion cutoff всех строк. Frozen offline install/typecheck/962общих теста/build PASS. Подменённый report в отдельной копии отклонён offline; исходный сбор неизменен. Финальный replay после сборки,54SQLchecksum/docs links/diff PASS. Read-only preservation:2232карты,3prediction_runs/снимка/сценария,13точных строк очереди, исходный forecastSHA и active model_eligible совпадают с состоянием до запросов. Разрешённые operational записи — только provider_quotas; импортированных карт/рабочих бизнес-записей0. API/UI/SQL/dependencies не менялись; standalone browser/PG integration suites не запускались, сервисы не перезапускались.

## Следующая задача

**S3-04/history-details:** зарегистрировать [отдельный bounded план](evidence/s3-04-history-details-proposal.json) и получить/проверить детали95новых ID, переиспользуя сохранённые receipts там, где они уже появились. Предел100detail HTTP attempts суммарно, включая retries, максимум2попытки/map; при исчерпании сохранить остаток как not_attempted. Два известных проблемных ID сначала разобрать локально. Сравнить discovery с detail по account/slot/time/league/outcome; сохранить конфликты и реальные source clocks. В этом срезе не импортировать карты, не менять identity/series вручную и не запускать fitting/activation.

План деталей пока draft, не зарегистрирован и не выполнен. Старые dataset/fit/evaluation/artifacts сохраняются. **Рекомендуемая модель: GPT-6 Astra · High.**
