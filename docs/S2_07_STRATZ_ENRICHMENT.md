# S2-07/STRATZ-enrichment — дополнение известных рейтинговых карт

Реализован следующий срез, выбранный владельцем продолжением после [проверки STRATZ](S2_07_STRATZ_VALIDATION.md). Сервис получает оценку позиции и код версии игры по известным OpenDota map IDs. Источник не меняет членство карт в основной выборке, игры/победы/WR или V1 Elo. [Проверки и сохранность](evidence/s2-07-stratz-enrichment.json).

## Как пользоваться

1. Откройте карточку игрока, например [Dendi](http://localhost:5173/players/61).
2. Раскройте **«Рейтинговая практика»**, источник **OpenDota**. Если истории ещё нет, загрузите её обычной кнопкой.
3. Под таблицей героев раскройте **«Дополнительные данные STRATZ»**. Раскрытие только читает кэш.
4. Нажмите **«Дополнить данные STRATZ»**. Выбираются до20 последних карт сохранённого наблюдения; сервер проверяет их в STRATZ пакетами до4 ID, максимум5 HTTP на одно обновление.
5. Проверьте покрытие и строки карт: герой/начало, оценка позиции, код версии STRATZ и результат сверки. Неизвестная позиция остаётся неизвестной. Таблица прокручивается горизонтально на узком экране и с клавиатуры.

Для Dendi совпали20/20 карт, позиция известна19/20, версия20/20. Основная выборка осталась197 карт/25 героев. Загрузка сделала5 STRATZ HTTP, повторная кнопка/перезагрузка —0. Это один ограниченный пример, не универсальное покрытие аккаунтов или гарантия точности позиции.

Используются прежний флаг RANKED_PRACTICE_ENABLED и локальный backend STRATZ token. Новый ключ/аккаунт владельца не требуется. STRATZ в селекторе самостоятельной истории по-прежнему не выдаёт геройские показатели: этот reader и дополнение известных ID — разные пути.

## Выборка, проверки и кэш

- Один parent OpenDota v2 observation, один заново проверенный canonical аккаунт. Выбор20 карт по startedAt DESC, затем числовому match ID, без выбора по герою/победе. Основной30-дневный период берётся из parent, включая сохранённый устаревший срез с исходными датами.
- GraphQL match(id) запрашивает только известные ID; arbitrary client map/account IDs endpoint не принимает. Decimal IDs проверяются до включения в GraphQL literals без Number-конвертации bigint. Небезопасные числовые ID ответа исключаются, числовые строки поддерживаются.
- Строка требует ranked lobby7/All Pick22, отсутствия league, одного точного Steam32 участника, native slot и согласованного исхода/времени. Только совпадение parent/source по map/account/hero/side/win/start/end разрешает применить metadata.
- Неполный/отсутствующий ответ и противоречия сохраняются с raw receipt, но спорные значения не применяются. Роль — estimated, не confirmed; provider version не становится canonical patch. Average lobby rank не равен личному MMR, party size из этого запроса не выводится.
- Cache key включает account+map+policy. Совпавшие данные действуют24 часа; missing/invalid/conflict —1 час. Новый parent переиспользует подходящие факты после повторной сверки: в тесте одна новая карта потребовала1 HTTP вместо5. Исходные receipts не переписываются.
- Account lease120 секунд исключает одновременные повторы. Shared durable quota, Retry-After, таймаут15 секунд, лимит ответа2MiB и отсутствие автоматического retry сохраняются. Ошибка останавливает оставшиеся запросы; сохранённые batches доступны. После cooldown обновляются только недостающие/устаревшие карты: в тесте16 вместо повторных20.
- Identity registry и текущий parent проверяются перед обращением и внутри публикации под SQL locks. Смена identity/parent во время сети не позволяет сохранить старый batch. Старый lease token не публикует данные и не снимает новую lease.

N основной выборки и selected/matched counts дополнения показаны отдельно. Неполное покрытие не образует role-specific WR. Дополнение не участвует в назначении командных ролей, pro-аналитике, training targets, модели или вероятности победы.

## API и хранение

Owner/CSRF `POST /api/v1/ranked-practice/context` принимает `{playerId:string,parentObservationId:UUID,refresh?:false}`. По умолчанию только чтение. RankedContextReport содержит parent/source/window/revision, not_loaded/ready/partial/unavailable, retryAt, selected/matched counts, строки с nullable metadata и source receipt ID/parent ID/fetchedAt/SHA. Старый/чужой parent возвращает unavailable; неизвестный player/невалидный input —400. Raw bodies/токенов в DTO нет.

Forward-only **SQL046** добавляет ranked_context_receipts (immutable payload/raw body/identity revision/parent/fetchedAt/recordedAt), ranked_context_map_cache и ranked_context_leases. Source knownAt=null; event time отдельно в map fields. Это pub context, не matches/match_players и не модельные snapshots. SQL001–045 сохранены.

Чистые selection/conflict functions — packages/analytics/src/ranked-context.ts; источник — packages/ingestion/src/ranked-context-client.ts; хранение/проекция — packages/db/src/ranked-context-repository.ts; orchestration — apps/api/src/modules/catalog/ranked-context.ts. Vue Query использует parent-bound keys; polling/reconnect/focus refresh выключены. Пока идёт ручное дополнение, смена источника и обновление parent заблокированы. Поздний ответ другого parent/source не заменяет текущую карточку.

## Проверка

Фактически выполнены: frozen offline install, root typecheck/build, **884 unit/CLI (17 новых),25 уникальных API/PG (13 context+12 прежних ranked),15 Chromium (7 context+8 прежних ranked) — PASS**. Начальный целевой прогон38 проверок включал14 новых pure/source/contract и24 API; после добавления recovery case повторены13 context API, повторы не увеличивают число уникальных проверок. Начальная типизация поймала лишнее поле в новой тестовой фикстуре; исправлена сама фикстура, итоговая типизация прошла.46 migrations/45 historical checksum и245 protected artifacts/150 original modules/frozen bundle/runtime проверены. Existing Node color/Rollup annotation/chunk-size warnings не блокировали проверки. Один docs patch не прошёл проверку контекста атомарно и был повторён без частичных записей.

Покрыты отбор/bigint/дубли, все core conflicts, input/provenance/count/window gates, unsafe payload/GraphQL/HTTP/timeout/response cap, auth/CSRF, immutable receipts, old-lease/hash/membership rejection, parent/identity races, cache reuse/cooldown/partial recovery, реальные UI действия и360px. Synthetic fixtures используются только в отдельных временных БД и тестах.

Рабочая проверка через прежнюю owner session: parent Dendi197 карт,20 настоящих source maps,5 receipts/20 cache rows. Повтор и reload не изменили кэш/квоту и не добавили HTTP. Parent/SHA/исходные N/WR сохранились. Desktop/mobile просмотрены,0 page errors/overflow/новых логинов. Из77 прежних public tables изменились только schema_migrations и role_profile_stratz_quota;75 полностью неизменны. С3 новыми context tables теперь80 таблиц.340 pro maps/3 ranked observations/model/identity/scenario facts и состояния очереди сохранены. API перезапущен22464, Web/history-worker сохранены.

Детальные команды/числа QA — в evidence. Ни commit/push/deploy, ни ML capture/evaluate/activation не выполнялись. Full Node/browser/Python/Docker/Linux suite не объявляется проверенным этим срезом.

**Следующая точная задача: S3-01/V1-evaluation/collection**, реальный сбор с20 ноября2026,03:00МСК, оценка не ранее2 декабря03:00МСК; frozen протокол сохранён. **GPT-6 Astra · Extra High.**
