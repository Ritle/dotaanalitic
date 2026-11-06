# S2-07/source-reader — отдельная рейтинговая история

Текущее дополнение: [описательные показатели OpenDota v2 по героям](S2_07_RANKED_HERO_SUMMARY.md) включены2026-11-06; summary рассчитывается на чтении без изменения immutable observations/SQL. Указания statisticsEnabled:false ниже описывают исходный reader-checkpoint; для STRATZ/v1 они сохраняются.

Источник требований: [§0.8](../TECHNICAL_SPEC.md), [source spike и контракт](S2_07_RANKED_PRACTICE_SOURCE.md). Реализован backend reader для одного verified игрока; [UI доступности](S2_07_RANKED_PRACTICE_UI.md) подключён2026-11-06. Геройские проценты ещё не включены. [Проверки и фактические source/DB результаты backend-среза](evidence/s2-07-ranked-reader.json).

**Текущий adapter v2 (2026-11-06):** [исправлен OpenDota project и получены197 ranked-карт Dendi](S2_07_RANKED_COVERAGE_CONTROL.md). Explicit project заменяет defaults, поэтому нужные hero/duration/context fields запрашиваются полностью. Payload v1 остаётся читаемым/immutable, его кэш считается stale и может вручную обновиться до TTL, без обхода lease/cooldown. Новые publications требуют v2. Исторические empty controls ниже сохраняют прежние результаты; текущий next — S2-07/hero-summary.

## API и запуск

Forward-only migration `045_ranked_practice.sql` добавляет две отдельные таблицы. Предыдущие SQL не изменяются. После миграции API поддерживает:

```http
POST /api/v1/ranked-practice
Content-Type: application/json
X-CSRF-Token: <токен текущей owner-сессии>

{"playerId":"20","provider":"opendota","refresh":false}
```

Нужны owner session cookie, разрешённый Origin и CSRF. `playerId` — canonical ID из локального каталога; account ID по nickname или от клиента не принимается. `provider`: opendota (по умолчанию) либо stratz. `refresh:false` только читает кэш; `refresh:true` явно обновляет устаревший/отсутствующий источник. Один свежий результат повторно не загружается. Лимит endpoint —20 запросов в минуту, durable provider quotas действуют дополнительно.

Флаг `.env` `RANKED_PRACTICE_ENABLED=true` включает загрузку. В `.env.example` и коде default=false. STRATZ требует собственный `STRATZ_API_TOKEN` и явный выбор provider; OpenDota допускает работу без ключа. Никакого фонового сбора или запроса провайдеру при открытии pro-отчёта.

Для обычного запуска применяются команды README: `pnpm db:migrate`, сборка и запуск API. Пароли/токены не включаются в параметры API, ответ или raw receipts. Локальные live-проверки и фактические QA результаты записаны в PROGRESS/evidence этого checkpoint.

## Статусы и данные

Ответ содержит provider, canonical player/account, текущую identity revision, snapshotAt, status/reason/retryAt, stale, observationId, observationIdentityRevision и observation. **`statisticsEnabled:false`** явно сообщает: этот срез ещё не публикует WR/геройские агрегаты.

| Status | Значение |
|---|---|
| not_loaded | Нет кэшированного результата; чтение не запускает загрузку |
| empty | Успешный источник, ни одного пригодного наблюдения, фактическая полнота unknown |
| ready | Есть валидные записи, выдача провайдера окончена, локальных исключений нет; полнота всей истории всё равно unknown |
| partial | Ограничение страниц, прерванная пагинация, исключённые строки или устаревший кэш |
| conflict | Конфликт личности либо противоречивые записи одной карты |
| unavailable | Неизвестная личность, отключённый/ненастроенный источник, отказ или ошибка без пригодного кэша |

Ошибка обновления сохраняет предыдущее observation и возвращает `partial/stale` с cooldown. Данные нового аккаунта не выдаются под старой canonical identity. Повторная проверка личности выполняется после HTTP и внутри транзакции публикации; identity registry блокируется на время фиксации revision. Immutable observation хранит именно revision публикации, текущая revision показана отдельно.

Пустой результат не превращается в «0%» или утверждение, что игрок не тренировался. Описательная source coverage — не оценка силы и не вероятность победы.

## Ограничения загрузки

- Фиксированное текущее окно30 суток, ranked lobby7/game mode22 (современный ranked All Pick). Произвольный исторический cutoff и иные режимы в этом endpoint не поддерживаются.
- Максимум2 последовательные страницы по100 строк. Нет автоматических retries. Ошибка второй страницы сохраняет первую с pagination=interrupted. Две полные страницы дают capped.
- OpenDota date31 используется как overfetch; точное локальное окно проверяется заново. STRATZ получает Unix start/end и локальную проверку. `significant=0`; STRATZ isStats не фильтруется скрыто.
- У каждой принятой карты есть известные account/map/hero, исход, native slot/сторона, start/duration/end. Герой должен присутствовать в локальном справочнике; unknown_hero исключается с предупреждением. Проверяется `from <= start < cutoff` и завершение строго раньше cutoff, включая проверку `start+duration`. League conflict, Turbo, неизвестные режимы, некорректные слоты, unsafe IDs и неполные обязательные поля исключаются с причиной.
- Для STRATZ нужен ровно один matching player; `isRadiant`, native slot и `isVictory` сверяются. OpenDota account в request path допустим как provenance; противоречивый account echo исключается. Сторона не выводится из индекса массива.
- Provider patch codes сохраняются отдельно. STRATZ position — estimated; OpenDota lane_role не считается pos1–5. Средний ранг лобби не является MMR игрока. Для STRATZ party size неизвестен; ноль не подставляется.
- Внутри провайдера повторная карта учитывается один раз. Противоречащая повторная карта удаляется из пригодного набора. Разные providers возвращаются отдельно: cross-provider объединение/статистика пока не реализованы, складывать counts двух источников нельзя.
- Транспорт:15 секунд на страницу,2MiB на ответ, redirect запрещён, JSON/schema validation, контроль echoed token, обезличенные error codes. STRATZ учитывает Retry-After и second/minute/hour/day exhaustion headers. OpenDota использует существующий общий durable budget.

## Хранение и кэш

`ranked_practice_observations` — append-only typed payload, verified account/canonical player, identity revision, raw bodies и их SHA-256, реальные source/fetched clocks. UPDATE/DELETE запрещены триггером. Raw bodies читаются только внутренней проверкой, HTTP-отчёт их не возвращает. `knownAt` неизвестен и остаётся null; fetchedAt не выдаётся за историческую доступность.

`ranked_practice_cache` — pointer на последнее immutable observation, lease, expiry, cooldown. Ключ provider/account. Lease50 секунд; истёкший или чужой token не может публиковать/очистить новую заявку. Публикация observation и указателя атомарна. Пригодная полная выдача хранится1 час; empty/partial —15 минут; ошибка — минимум60 секунд cooldown (с учётом Retry-After и общего provider budget).

В `matches`, `match_players`, pro aggregates, training datasets и prediction runs данные не записываются. Рейтинговая карта не является training target и не обновляет Elo.

## Публичная контрольная проверка

Помимо прежних шести аккаунтов проверены verified Yatoro321580662 и Collapse302214028: Yatoro OpenDota/STRATZ и Collapse OpenDota, максимум6 HTTP по заранее сохранённому плану. Все три30-дневные ranked выдачи пусты. После этого отдельное дополнение плана использовало ещё2 запроса последней provider-visible карты Yatoro без фильтра периода/режима; суммарно5 HTTP, ниже исходного общего cap6.

Оба источника вернули карту9071885340 от2026-11-01T15:49:50Z и согласованные Practice / Captains Mode. В STRATZ указан league20395; у OpenDota diagnostic projection league не запрашивался, его отсутствие не является конфликтом провайдеров. Это непустой контроль доступности истории, **не ranked sample**. Он показывает, почему нельзя подменять рейтинговую выборку последними видимыми картами. Причина отсутствия остальных ranked-наблюдений всё ещё unknown; профиль не объявляется закрытым без подтверждения.

Непустые ranked-поля/пагинация пока не проверены эмпирически; happy/edge случаи валидируются синтетическими тестами. До подключения геройской статистики нужен отдельный небольшой публичный ranked контроль. Ошибки этого источника не блокируют существующие pro-отчёты.

## Фактически выполненная проверка

Frozen offline install, root typecheck/build, **852 unit/CLI +10 API/PG** — PASS. После последней проверки hero catalogue отдельно повторены API typecheck/build; identity publication получила дополнительный PG regression. Миграция045 применена к рабочей БД, локальный флаг включён, API перезапущен (PID28972); Web/worker не перезапускались.

Live owner API: существующая session cookie,0 новых логинов, cache-only → not_loaded/0 provider HTTP; manual refresh → empty/1 HTTP; повторный refresh → тот же observation ID/0 HTTP. Всего в этом срезе6 provider HTTP200:3 ranked controls +2 latest-visible diagnostics +1 API refresh. Append-only observation1, cache entry1, usable ranked maps0.

Рабочая БД75→77 public tables. По общему сравнению до контролей/после smoke72 исходные таблицы полностью неизменны; изменились только OpenDota quota, STRATZ quota и schema_migrations, добавились2 ranked tables.340 pro maps и очередь сохранены.245 защищённых artifacts/150 исходных modules/frozen bundle/runtime compatibility — PASS. Внутренние ссылки,45 миграций с прежними checksum и diff whitespace проверены. Полные Node/browser/Python/Docker/Linux suites не перезапускались.

Первый integration запуск использовал прежний compiled client с округлением fetchedAt вверх; исправлена точность миллисекунд и добавлена regression. Затем исправлен SQL-assertion теста (`matches.id`). Вспомогательный live mjs первоначально содержал TS generic и остановился до provider HTTP; исправлен. Чтение UTF-16 QA logs в evidence helper также скорректировано. Итоговые проверки прошли; эти ошибки не меняли данные пользователя.

Исторические срезы S2-07/reader-ui и ranked-coverage-control выполнены2026-11-06. Текущий следующий: **S2-07/hero-summary**, см. [непустой OpenDota контроль](S2_07_RANKED_COVERAGE_CONTROL.md). STRATZ ranked-поля ещё не подтверждены непустой live выборкой. **GPT-6.1 Sol · High.**
