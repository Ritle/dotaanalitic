# S0-01 — OpenDota provider spike, 2026-10-30

S0-01 выполнен: реальные `/proMatches`, `/matches/{id}`, `/teams/{id}`, `/teams/{id}/players`, `/players/{id}` проверены через server-side клиент. Добавлены строгая проверка consumed fields, пять обезличенных fixtures и отчёт о покрытии. Это подготовка к S0-02; импорт и классификация pro-карт, worker, durable quota и model activation не реализовывались.

## Эмпирическое покрытие

Запущен существующий `scripts/audit-prediction-sources.mjs --sample 20`: `mode=live_opendota`, `schema_version=2`, generated at **2026-10-30T17:07:48.208Z**. Получены 20/20 detailed responses, ошибок карт — 0. Это первые 20 уникальных IDs из недавней страницы discovery, без стратификации по лигам, времени или патчам.

Полный public coverage report: [evidence/s0-01-live-coverage.json](evidence/s0-01-live-coverage.json). Он содержит флаги/аномалии и публичные map IDs, без персональных профилей, ключей и raw HTTP payload. SHA-256 файла: `024ae1aee62a0efd6d78a4bd01ffe531a2f4080db5ead49c67a396228e3ca4a9`. SHA-256 использованного audit script: `f6336ea49ba9335df2fcb630b1bee92a9c1c76dbf722c31c23fedad8e8ceef16`.

| Поле/проверка | Наличие на выборке |
|---|---:|
| Соответствие map ID, start time, исход, league | 20/20 |
| Provider patch field | 20/20 |
| Десять уникальных native slots | 20/20 |
| Десять непустых account ID (флаг текущего аудитора) | 20/20 |
| Десять различных финальных героев | 20/20 |
| Две различные организации | 15/20 |
| Ненулевой series ID | 15/20 |
| Непустой массив raw draft actions | 20/20 |
| Ровно 10 пиков, совпадение героев/сторон, структурная согласованность | 19/20 |
| Целочисленные уникальные draft order | 20/20 |
| lane_role hint у десяти игроков | 20/20 |
| Исторические правила draft order / known-before-start lineup | Не проверены |

Missing teams/series у `9067217876`, `9067149165`, `9067078024`, `9067007060`, `9066936100`. Последняя карта содержит 12 различных raw pick events при 10 финальных героях; дополнительные hero IDs — 2 и 60. Причина расхождения не установлена. `patch` здесь означает присутствие provider field, а не подтверждённую release timestamp/hero eligibility. `identity_10` существующего аудитора проверяет наличие ID, а не canonical identity links или историческую известность.

`draft_order_valid=null` на всех 20 картах. `lane_role` не является подтверждённой позицией 1–5; `proMatches` не заменяет отдельную league/tier classification. Эти показатели не дают разрешения на тренировку или публикацию вероятностей.

## Отдельный live spike через новый клиент

Успешный запуск завершён **2026-10-30T17:13:43.248Z**, 7 HTTP attempts: discovery + 3 detailed maps + team + team players + player profile. Все observation `attempts=1`; повторов на этом запуске не было. Существующий 20-map аудитор не записывает промежуточные retry counters, поэтому отсутствие failed maps не означает доказанное отсутствие промежуточных 429/5xx там.

| Карта | Raw events / picks | Team/series metadata | Наблюдение |
|---|---|---|---|
| 9067217876 | 18 / 10 | отсутствуют | финальные 10 heroes и slots сохранены |
| 9066936100 | 20 / 12 | отсутствуют | extras не удалены и timeline не сертифицирован |
| 9063023867 | `null` / `null` | присутствуют | массив отсутствует при наличии финальных героев |

У всех трёх карт валидны 10 slots, 10 различных account IDs и 10 финальных heroes. Наблюдался provider patch ID 60; game_mode — 22 и 1, lobby_type — 1. Исторические правила по этим значениям не проверялись. `9063023867` проверен явно указанным ID, не выдан за свежую discovery-карту.

Ранее владелец сообщал один raw event и ноль пиков для `9063023867`. Текущий source response вернул `picks_bans:null`; причина изменения неизвестна, прошлое наблюдение не переписывается. Payload SHA-256 текущего ответа: `f09a3d57ad0ab33197f05898281e17439c304d76ae3168b716f6bd7380a7de1d`, fetched at `2026-10-30T17:13:40.154Z`.

Team endpoint и player profile прошли Zod. Team players вернул 10 исторических записей; положительных current-member flags — 0. Это не нулевая фактическая пятёрка: nullable membership остаётся неизвестным. Будущая/историческая пятёрка и роли не назначались. Player endpoint не используется как источник профессиональных побед/истории.

## Provider boundary и эксплуатационные границы

- `apps/api/src/providers/opendota/schemas.ts`: проверка known fields, nullable/absent facts, safe numeric IDs либо decimal BIGINT strings. Небезопасные numbers, неправильные типы и несовпадение requested/returned IDs отклоняются. Дополнительные поля провайдера не делают всю карту непригодной для будущей отдельной quality policy.
- `client.ts`: фиксированный HTTPS host/path, только известные endpoint methods, без произвольного URL; `Authorization: Bearer` при заданном ключе, redirects запрещены. Оригинальный UTF-8 body хранится отдельно в internal observation с SHA-256; typed projection может преобразовать zero-ID sentinel в `null`, source body не изменяется.
- Очередь внутри одного client instance: один запрос одновременно, <=45 starts/min, максимум 25 attempts на CLI run, максимум 3 попытки на запрос, timeout 15 s включая чтение body, лимит ответа 8 MiB. Retries ограничены network/timeout/429/5xx; обычные 4xx и ошибки схемы не повторяются.
- Backoff с jitter + Retry-After seconds/HTTP date. Если ожидание сервера превышает 30 s, вызов возвращает код и delay; следующий вызов того же instance также не идёт раньше server cooldown. Глобальная durable очередь/дневной/месячный счётчик остаются S0-02.
- `fetchedAt`, `knownAt:null` и map `eventAt` раздельны. Нет предположения, что загруженная после игры пятёрка была известна до старта. Raw HTTP тела, заголовки авторизации и provider error text не выводятся в stdout/coverage report.
- CLI пишет только отчёт в игнорируемую `reports/`. Новых HTTP routes, DB writes, моделей или production mocks не добавлено.

## Fixtures и воспроизведение

Пять файлов в `tests/fixtures/opendota/provider-spike/`: discovery, два detailed map projections, team/roster, player profile. Они сформированы из реально полученной формы ответа, но IDs, timestamps и числовые статистические значения заменены, имена/личные поля удалены; каждый помечен `synthetic:true`, `origin:sanitized_live_shape`. Это тестовые формы данных, не подлинные raw-ответы и не статистика профессиональных матчей. Оригинальные порядок/число событий и nullability сохранены для проверки boundary.

```powershell
pnpm provider:spike --sample 3
# Явный ограниченный набор; CSV в PowerShell обязательно заключать в кавычки:
pnpm provider:spike --match-ids '9067217876,9066936100,9063023867'
# Только для нового набора тестовых проекций (существующие файлы не перезаписываются):
pnpm provider:spike --match-ids '9067217876,9066936100,9063023867' --fixtures reports/new-fixtures
node --env-file-if-exists=.env scripts/audit-prediction-sources.mjs --sample 20 --out reports/opendota-coverage.json
```

Отчёты по умолчанию разрешаются относительно Git root независимо от workspace cwd. `OPENDOTA_BASE_URL` разрешён только `https://api.opendota.com/api`, ключ берётся только из env. Не запускать разные CLI параллельно ради обхода квоты.

## Условия источника и лимиты

Проверены [официальный OpenAPI 31.1.1](https://api.opendota.com/api), [страница документации](https://docs.opendota.com/), [объявление Free Tier](https://blog.opendota.com/2018/04/17/changes-to-the-api/) и [текущие defaults upstream](https://github.com/odota/core/blob/master/config.ts).

OpenAPI допускает API без ключа и описывает Bearer authentication. Старое объявление указывает 50k/month, но upstream defaults теперь содержат 3000/day и 60/min без ключа; это code defaults, не подтверждение deployed settings. В первом response нового spike наблюдались remaining-minute **58**, remaining-day **2977**, remaining-month — отсутствовал. Это остатки на момент ответа, не доказательство общей квоты аккаунта/IP. На S0-02 нужно учитывать реальные headers, 429/Retry-After и собственные durable квоты; нельзя полагаться только на старые 50k/month.

Принятый scope использования — приватная персональная аналитика через документированный API в пределах ограничений; платный API не включается автоматически. Коммерческая/публичная раздача данных, hero art и logos не проверялись и не выполняются. Лицензия исходного кода не трактуется как отдельное разрешение на перераспространение всех данных/изображений. Контакт с провайдером от имени владельца не выполнялся.

## Проверки и следующий этап

PASS: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test` (54, включая 28 новых provider/fixture cases), `pnpm build`, Node regression tests (10), PostgreSQL integration (4), migration checksums (6), doc links, health smoke и live spike/audit. Новых dependencies и миграций нет. UI/Python/E2E не менялись и повторно в S0-01 не запускались; Docker и remote GitHub Actions остаются непроверенными, как после S0-00.

Следующая задача: **S0-02** вместе с предусмотренными контрактами S0-10 — идемпотентный импорт, raw evidence + отдельная quality policy, worker и durable provider quota. Рекомендуемая модель: **GPT-6.1 Sol · High**. S0-08/09 остаются открыты: историческая стратификация и known-as-of ещё не выполнены.
