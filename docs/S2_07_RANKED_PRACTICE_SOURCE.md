# S2-07 — источники рейтинговой практики и контракт первого блока

Текущее состояние: [OpenDota hero summary](S2_07_RANKED_HERO_SUMMARY.md) реализован. [STRATZ-validation6 ноября](S2_07_STRATZ_VALIDATION.md) подтвердил дополнительные поля4 известных карт через match(id), но не непустую player ranked history; самостоятельные показатели STRATZ выключены. Ниже сохранены исходные результаты первого spike, без подмены их более поздней проверкой.

Дата проверки source spike: 2026-11-05. Владелец явно выбрал S2-07 вместо ожидания окна V1. Основание: [TECHNICAL_SPEC §0.8](../TECHNICAL_SPEC.md), AGENTS v10. Этот документ сохраняет результат первого spike и исходный контракт. Позднее реализованы [backend reader/cache](S2_07_RANKED_PRACTICE_READER.md), [UI доступности](S2_07_RANKED_PRACTICE_UI.md) и [v2/full-project control197 ranked-карт Dendi](S2_07_RANKED_COVERAGE_CONTROL.md). Пустые ответы первоначальных аккаунтов остаются фактами их проверки; project необходимо перечислять полностью, он не дополняет defaults. Геройские проценты/влияние на прогноз ещё не реализованы; текущий next — S2-07/hero-summary.

## Результат живой проверки

OpenDota и STRATZ доступны, но **ни один из шести проверенных аккаунтов не вернул рейтинговые матчи в выбранном окне**. Это результат проверки доступности, а не нулевой опыт игроков. Точный источник пустой выдачи не установлен. Нельзя утверждать, что новый токен, иной провайдер или расширение периода обязательно дадут историю.

[Машиночитаемые доказательства](evidence/s2-07-ranked-source-audit.json): планы до HTTP, фильтры, запросы, временные отметки, SHA-256 локальных ответов, квоты, проверка неизменности данных. Raw receipts и вспомогательные audit scripts находятся только в ignored `.tools/s2-07-ranked-*`; ключей в manifest нет.

- Фиксированное окно: **[2026-10-06 20:15:29 UTC, 2026-11-05 20:15:29 UTC)**, 30 суток.
- Только современное ranked-лобби `7` и All Pick `22`. Это явно ограниченный поднабор рейтинговых режимов, не вся ranked-история.
- Первоначально Bignum, RCY, Yuma: 1 проверка схемы STRATZ + 6 запросов истории. После пустых результатов отдельный план добавил двух остальных локально подтверждённых игроков GL и youngG; ещё 6 запросов с теми же фильтрами и cutoff. Дополнение не переписывает первый план, выбор не основан на победах/героях.
- Итого **13 HTTP 200**, из них 1 schema и 12 history; 0 GraphQL errors, 0 retries, 0 ответов 429/5xx. Каждый ответ истории — первая пустая страница, пагинация не выполнялась.
- До запросов каждый canonical player прошёл действующий `RoleProfileRepository.identities`: ровно один verified Steam32 account, без конфликтов. Новые связи по никам не создавались.

| Canonical player / подпись | Steam32 | OpenDota строк | STRATZ строк | STRATZ `isAnonymous` / `isStratzPublic` |
|---|---:|---:|---:|---|
| 22 / Bignum | 90423751 | 0 | 0 | false / false |
| 24 / RCY | 154974246 | 0 | 0 | true / false |
| 26 / Yuma | 177203952 | 0 | 0 | false / false |
| 23 | 93526520 | 0 | 0 | true / false |
| 25 | 160119017 | 0 | 0 | true / true |
| 223 / youngG | 127530803 | 0 | 0 | false / false |

Флаги профиля сохранены буквально. Их описание в доступной introspection отсутствует. Нельзя приравнивать `isAnonymous` к отсутствию подтверждённой личности, а `isStratzPublic=false` — к доказанной причине пустого ответа. Аккаунт с `isStratzPublic=true` также вернул пустую историю. Токен принят для этих запросов, однако это не доказательство доступа ко всем данным STRATZ.

**Не измерено:** наличие героев/исходов/ролей/патчей/party в непустых pub-строках, согласованность двух источников, фактическая пагинация, общая полнота истории. При нуле строк эти показатели `null`, а не 0% или 100%. Выборка целевая и небольшая; нельзя переносить результат на всех профессиональных игроков.

## Проверенная семантика запросов

### OpenDota

Использован `GET /players/{account_id}/matches` с `lobby_type=7&game_mode=22&significant=0&date=31&limit=100&offset=0&sort=start_time`; дополнительные `project`: account_id, leagueid, lane_role, party_size, average_rank, leaver_status, patch.

[Официальные параметры](https://github.com/odota/core/blob/master/svc/api/requests/playerParams.ts) описывают limit/offset, lobby/game mode, относительный период и project. `significant=0` снимает дополнительный фильтр агрегации; применимость каждой карты всё равно проверяется локально. [Реализация date](https://github.com/odota/core/blob/master/svc/util/filter.ts) использует время запроса, поэтому загружается 31 сутки и затем требуется локальное точное окно 30 суток с зафиксированным cutoff. Это не готовый API исторического as-of.

[Официальные lobby constants](https://github.com/odota/dotaconstants/blob/master/json/lobby_type.json) определяют `7` как ranked; [game-mode constants](https://github.com/odota/dotaconstants/blob/master/json/game_mode.json) — `22` как all_draft, `23` как Turbo. Legacy ranked lobby 5/6 и другие режимы не включены в этот срез.

[Default match projection](https://github.com/odota/core/blob/master/svc/api/playerFields.ts) предусматривает героя, время, длительность, lobby/mode, средний ранг и party size. Дополнительный project не гарантирует наличие данных. `lane_role` не равен подтверждённой позиции 1–5. [Обработка private history](https://github.com/odota/core/blob/master/svc/util/buildPlayer.ts) допускает пустой список, но сам список не отличает privacy от отсутствия доступных записей за период.

### STRATZ

Использован стандартный [GraphQL API](https://stratz.com/api) с собственным серверным токеном. В текущей авторизованной introspection проверены поля `PlayerMatchesRequestType`; запросы приняты без GraphQL errors. Основные аргументы:

```graphql
player(steamAccountId: $account) {
  steamAccountId
  steamAccount { isAnonymous isStratzPublic }
  matches(request: {
    startDateTime: 1791317729, endDateTime: 1793909729,
    lobbyTypeIds: [7], gameModeIds: [22],
    take: 100, skip: 0, orderBy: DESC, playerList: SINGLE
  }) {
    id startDateTime endDateTime durationSeconds didRadiantWin
    lobbyType gameMode leagueId gameVersionId averageRank isStats
    players(steamAccountId: $account) {
      steamAccountId playerSlot isRadiant isVictory heroId
      position role lane partyId leaverStatus
    }
  }
}
```

Полная executed query с variables сохранена в evidence. Introspection описывает даты как Unix seconds; точную включительность границ и работу skip на непустой выдаче ещё нужно проверить. Локальные границы обязательны независимо от серверного фильтра.

`isStats` не передавался в фильтр: это внутренняя оценка пригодности матча STRATZ, не признак pro/ranked. Наличие поля в схеме не доказывает его заполнение. `partyId` не равен размеру группы; при SINGLE нельзя восстановить solo/party из числа возвращённых игроков. Источник позиции хранится как оценка провайдера. `gameVersionId` остаётся в namespace STRATZ, не записывается в canonical `patch_id` напрямую.

## Контракт следующего среза

Контракт ниже предназначен для реализации `S2-07/source-reader`; это ещё не работающие endpoints или SQL-таблицы.

1. **Отдельный необязательный отчёт** для canonical player с verified account и явным периодом. Первый режим — 30 суток, ranked All Pick. Иные окна/режимы добавляются явно. Успех или ошибка этого блока не меняет pro-отчёт, составы и V1 Elo. Никакого бонуса к вероятности за pub WR.
2. **Source status и статистика раздельны:** `not_loaded | ready | partial | empty | unavailable | conflict`. `empty` означает успешную выдачу без подходящих наблюдений; причина и фактическое покрытие могут оставаться неизвестными. `unavailable` — ошибка/явный отказ доступа. Частичные GraphQL errors не становятся успешным пустым ответом. При отсутствии пригодных данных `heroes=[]`, WR отсутствует; UI пишет «Данные рейтинговых игр за период не получены», а не «Игрок не играл».
3. **Нормализованное наблюдение:** canonical player ID, verified account ID, Dota map ID, hero ID, startedAt, completedAt и основание времени завершения, сторона, win; provider/adapter revision, request/filter snapshot, sourceKnownAt, fetchedAt и raw SHA. IDs в JSON — decimal strings; небезопасные numeric IDs отвергаются. У строки должен быть ровно один участник с запрошенным аккаунтом. Отсутствие echo account ID в OpenDota допускается только с явным provenance аккаунта в адресе запроса; противоречивый echo отвергается.
4. **Допуск карты:** положительно проверенные ranked lobby и разрешённый game mode, реальный hero ID, известный исход и корректная сторона, валидные start/duration/end. `fromAt <= startedAt < cutoffAt` и завершение строго до cutoff. Turbo/unranked/custom/unknown и явный league/pro конфликт исключаются с причиной. Нельзя выводить сторону из индекса массива. Проверить native slot encoding каждого провайдера на непустом ответе; считать победу по явной стороне, сверять с player `isVictory`, если есть.
5. **Optional context:** provider patch code/label, position/lane и её статус `estimated|unknown`, средний ранг лобби, partySize/soloParty, leaver status. Неполный контекст не выбрасывает иначе пригодную карту. Средний ранг не является MMR игрока; отсутствие party size не означает solo. Unknown patch не заполняется текущим патчем. Историческая роль не переписывает назначенную владельцем роль.
6. **Дедупликация:** одна запись опыта на `(accountId, matchId)`, даже при двух источниках/повторной странице. Хранить обе source observations. Конфликт героя, стороны, исхода или времени не разрешать тихим выбором источника; исключить конфликтующую карту из объединённой статистики и показать причину. Игроки в одной карте — отдельные player observations, не дополнительные независимые pro-карты.
7. **Показатели игрок×герой:** observed games, wins, raw WR, последняя наблюдённая карта. Для выбранного героя с нулём наблюдений `n=0`, `rawWinRate=null`; это не отсутствие опыта. Не выдавать сглаженную оценку за raw WR. Первоначально никаких весов, priors или штрафов. Pro и pub имеют отдельные denominators, storage/query и названия в UI.
8. **Coverage:** provider rows received, accepted unique maps, excluded reasons, duplicates/conflicts, first/last observed time, requested window, pages/cap/cursor, fetchedAt, freshness, identity revision, effective filters. Два независимых понятия: окончена ли выдача провайдера и известна ли реальная полнота истории. Пустая/короткая страница сама по себе не доказывает полноту всех игр игрока. При cap показывать «Показана часть доступной истории». Для этого аудита фактическое покрытие — unknown.
9. **Clocks:** source `knownAt` остаётся null, когда не предоставлен. fetchedAt не становится старым временем доступности. Текущий описательный отчёт не разрешает использовать эти observations в историческом прогнозе. Будущие признаки потребуют отдельной availability policy и временной проверки; текущая lifetime-статистика непригодна для старого cutoff.
10. **Запросы и кэш:** только защищённый backend; чтение отчёта не запускает HTTP к провайдерам. Явное обновление одного игрока, bounded pages/attempts, single-flight, общий PostgreSQL quota и Retry-After. Использовать существующие shared budget boundaries; STRATZ остаётся optional. Переключение провайдера сохраняет отдельные статусы и provenance. Не делать вызов на каждого героя и не запрашивать full match для каждой строки без измеренной необходимости. Точный TTL/лимиты зафиксировать в реализации. Пустой ответ тоже кэшируется, повторные открытия не расходуют квоту.

Для первого UI достаточно компактного блока «Рейтинговые игры» рядом с pro-показателями: период, обновление, N/WR, давность, предупреждение покрытия. Подробности источника — раскрываемые; дополнительных обязательных форм для сравнения команд нет.

## Проверки и ограничения этого checkpoint

- 13 receipt SHA/размеров/status/timestamps и параметры 12 history запросов проверены локальным assertion script; 6 verified accounts, 0 returned rows подтверждены. Все запросы используют durable budgets. Квоты, видимые в HTTP headers, сохранены без credentials.
- 75 рабочих public-таблиц: **73 неизменны**, изменились только `provider_quotas` и `role_profile_stratz_quota`. Очередь не изменилась; 340 pro-карт, сохранённые identity/roster/scenario/model данные сохранены. Pub-карт импортировано 0.
- **245 защищённых файлов, 150 исходных модулей, frozen bundle и runtime compatibility — PASS.** Модель, collection plan и окно проверки V1 не менялись.
- Проверка внутренних Markdown links, всех44 SQL migration checksums и `git diff --check` — PASS.
- Первый sandbox DB read получил EACCES; scoped запуск с доступом к localhost прошёл. Дополнительный read-only запрос подписи игрока использовал отсутствующую SQL-колонку `name` (42703); identity resolver уже успешно проверил аккаунты. Это ошибки вспомогательной проверки, не изменения приложения.
- Production код, API, SQL, dependencies и UI не менялись. Полные install/typecheck/test/build, браузерные, PG integration, Python и Docker suites для этого audit/docs checkpoint **не перезапускались**; результаты предыдущего checkpoint не выдаются за новые тесты.

**Следующая задача: `S2-07/source-reader`** — отдельный bounded reader с typed validation, кэшем и честными empty/unavailable/partial состояниями. Перед включением hero statistics проверить непустую публичную контрольную выборку, границы периода, реальные fields и pagination; не искать доступ к явно закрытой истории. Если контроль также пуст, reader должен работать с unavailable/empty, без вымышленных чисел. Рекомендация: **GPT-6.1 Sol · High**; контракт и ограничения источников зафиксированы.

S2-07 целиком остаётся открытой. Реальный сбор V1 начинается 20 ноября 03:00 МСК; evaluation не раньше 2 декабря 03:00 МСК. Рейтинговая практика не добавляет этому релизу новый prerequisite.
