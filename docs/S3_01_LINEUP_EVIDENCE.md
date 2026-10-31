# S3-01 — регистрация на TI12 и фактический состав карты

Проверено 2026-11-01 по Москве. Для карты **7378530387**, начавшейся **2023-10-12T17:00:44Z**, найдены обе зарегистрированные пятёрки в официальном архиве Valve от **2023-10-07T10:14:14Z**. Все десять numeric account IDs совпадают с участниками карты и разрешаются в уже созданные canonical IDs. Это закрывает проверку регистрации этих игроков на турнир, но **не доказывает объявление состава именно этой карты до её начала**. S3-01 остаётся открытой; verified map lineups / training examples = 0.

## Что подтверждено

| Источник | Проверенный факт | Граница доказательства |
|---|---|---|
| [Архив Valve GetLeagueData](https://web.archive.org/web/20231007101414id_/https://www.dota2.com/webapi/IDOTA2League/GetLeagueData/v001?league_id=15728&delay_seconds=0) | league15728, registration period8; 100 зарегистрированных игроков; по5 нужных numeric IDs в teams8291895 и8260983 | Регистрация на турнир, не явка на определённую карту |
| Архивное расписание в том же ответе | 8 групп,70 узлов;0 узлов с match7378530387 или обеими выбранными командами | Связь зарегистрированных пятёрок с этой встречей отсутствует в данном снимке |
| [Текущий официальный ответ карты](https://www.dota2.com/webapi/IDOTA2DPC/GetLeagueMatchMinimal/v001?league_id=15728&match_id=7378530387) | Десять аккаунтов, native slots и start совпадают с ранее сохранённым OpenDota; Radiant8291895/Dire8260983 | Получен после матча; availability=retrospective_fact, knownAt=NULL |
| [Применённый identity ledger](evidence/s3-01-ti12-identity-applied.json) | Revision20:10/10 canonical participants разрешены существующим IdentityResolver на cutoff карты | Связь аккаунта с canonical ID не доказывает доступность состава до матча |

Сохранены только выбранные десять публичных регистрационных строк и проекция account/slot/team для карты. Исходы, герои, kills/GPM, призовой фонд, администраторы и остальные90 регистрационных строк в новые tracked reports не включены. Организации не подменяют состав; team1/team2 расписания не подменяют Radiant/Dire. Одна карта остаётся одной картой, а не десятью обучающими примерами.

## Почему прогнозы ещё заблокированы

Совпадение зарегистрированных и фактически сыгравших игроков не исключает замену, неопределённость состава или отсутствие его публичного объявления до старта. Поэтому нельзя записать октябрьскую дату регистрации как knownAt фактического map lineup. Поздний ответ API также нельзя датировать задним числом.

Это блокирует включение карты в **strict_verified_asof** обучающую выборку и утверждение, что проверка воспроизводит реальный предматчевый прогноз. Помимо состава остаются независимые side/series/patch/coverage gates, достаточный корпус и temporal backtest; для post-draft — датированное доказательство доступности всех10 героев. Описательные отчёты и отдельное ретроспективное исследование могут работать. Вероятности по-прежнему unavailable; никакая модель не обучена и не активирована.

## Воспроизведение

```powershell
pnpm install --frozen-lockfile
pnpm cohort:lineup --out reports/new-ti12-lineup-evidence.json
pnpm test:fixtures
```

`cohort:lineup` не подключается к БД. Он фиксирует прежнюю карту, проверяет SHA map observation / identity apply manifest и использует вложенный frozen ledger revision20. Затем делает точный CDX-запрос по league URL, выбирает последний **из возвращённых** снимков до старта независимо от содержимого/исхода, проверяет CDX digest, original URL, Memento, timestamps и bounds, получает текущих участников карты и сопоставляет numeric IDs/slots. Обычно3 запроса, общий лимит6 с ограниченными повторами, задержкой и Retry-After. Отчёт пишется один раз; overwrite и пути вне проекта отклоняются до HTTP.

Exit0 / captureStatus=complete означают, что источники получены и проверка воспроизведена. Они **не** означают готовность датасета: strictDatasetStatus=unavailable, trainingReady/deployable=false. Частичный capture сохраняет ошибки и заканчивается exit3; неверный вход/путь — отдельный отказ. Новых SQL, DB writes и API/UI endpoints нет.

- [Основной отчёт](evidence/s3-01-ti12-lineup-evidence.json): SHA `e6a9e4276523efd57b0ff6095edc2eb6a27a96bb2292efbb1637bb508b8f8a14`.
- [Ограниченный поиск](evidence/s3-01-ti12-lineup-probes.json) и [manifest](evidence/s3-01-ti12-lineup-evidence.manifest.json): SHA входов, raw/projection replay, состояние БД и счётчики запросов.
- Архивный payload SHA `f405025ee598e1dc09ef520e25ec47cbd9ca6ee1bcd0e61f389adc3c9c594dc8`; knownByAt2023-10-07T10:14:14Z, финальный fetchedAt2026-10-31T23:47:22.606Z. Дата вступления регистрации в силу отдельно не установлена.
- Текущий map payload SHA `fa87d39e87d55f335119f6989cfc863d31a6783354109ea87aa28700bc5d9fe6`; event/start2023-10-12T17:00:44Z, fetchedAt2026-10-31T23:47:23.656Z, knownAtNULL.

Пять exact-URL CDX probes дали один непустой индекс league и четыре пустых: minimal map, TI12 watch, OpenDota exact map и пакетный league endpoint. URL/параметры Valve взяты из ранее сохранённого официального frontend-кода. Для первых четырёх запросов окно2023-10-01…2023-10-12T17:00:43Z, для пакетного — с2023-10-11; limit5/collapse day. Пустой ответ относится только к этому URL, параметрам и окну: отсутствие источников в интернете не доказано. Итого10 прямых HTTP200:7 поисковых/проверочных +3 финального CLI, без OpenDota data API calls и quota writes. Просмотр документации через web search в этот сетевой счётчик CLI не входит.

## Следующий точный шаг

Проверки этого среза PASS: frozen install, typecheck,395 unit (13 новых), build,52 Node artifact/CLI tests (4 новых), migration verifier18/golden001–005,16 source/runtime hashes и raw/projection replay, docs links/diff. Рабочая БД прочитана в read-only transaction:10 players/proofs/aliases, revision20, maps1/datasets0/active_models0/tempDB0, без новых записей. PG integration/browser E2E/Python не менялись и в этом срезе не повторялись. Известные предупреждения Rollup об аннотациях Zod сборку не блокируют.

**Продолжить S3-01: подготовить явный retrospective context proof этой карты через существующий evidence/readiness boundary и проверить отдельную conditional_lineup_reconstructed cohort.** Использовать numeric→canonical mapping и реальные native slots, сохранить поздний fetchedAt / неизвестный knownAt и явно перечислить допущения. Сначала проверить существование/import provenance карты в БД; не создавать context для несуществующей карты и не брать label из регистрационного ответа. Strict reader и DatasetBuilder strict policy остаются неизменными; readiness не равна training eligibility.

Такой отдельный эксперимент предусмотрен [PREDICTION_DATA_SPEC](PREDICTION_DATA_SPEC.md) §6–10 и [S0-09](S0_09_DATA_READINESS.md). Он не закрывает S3-01, не заменяет четыре непустых временных окна и не разрешает публикацию модели. Новые поиски strict pre-start evidence имеют смысл при появлении конкретного нового источника; не повторять те же пустые запросы или уже завершённый identity provision. S3-02 автоматически не начинать. Рекомендуемая модель — **GPT-6 Astra · Extra High**; переключение вручную.
