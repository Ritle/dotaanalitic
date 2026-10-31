# S3-01 — архивный реестр аккаунтов и проверка канонических связей

Проверка 2026-11-01, timestamps в UTC. **Архив OpenDota `/proPlayers` от 2023-04-11 содержит все 10 account ID ранее выбранной карты TI2023, включая 184620877.** Локальный снимок identity ledger пуст: 0 канонических игроков и связей. Найденные строки дают основания для следующего шага проверки связей, но сами не создают canonical player, состав карты или обучающий пример. S3-01 остаётся открытой.

## Найденные источники

Карта 7378530387, начало 2023-10-12T17:00:44Z, и её десять native slots взяты из прежнего [снимка аккаунтов](evidence/s3-01-ti12-map-accounts.json); нового OpenDota запроса карты не было. Выбор не менялся по исходу, команде или найденному coverage.

Точный CDX query для `/players/184620877` до карты пуст. Первый ограниченный индекс `/proPlayers` за 2021–2023 вернул пять архивов 2022 года; первый возвращённый snapshot от 2022-02-21 содержит 2659 строк и восемь нужных аккаунтов, без 184620877 и 346412363. Отдельное окно 2023 года вернуло пять более поздних архивов. Первый из них, [2023-04-11T21:06:28Z](https://web.archive.org/web/20230411210628id_/https://api.opendota.com/api/proPlayers?), содержит 2877 строк и все десять нужных аккаунтов. Это ограниченные запросы, не полный обзор архива; пустой query не доказывает глобального отсутствия источников.

В [документации OpenDota](https://opendota.apidocumentation.com/) `/proPlayers` описан как список pro players. Для выбранных десяти строк совпали Steam32 и Steam64; `is_pro` и `is_locked` равны true. В отчёте они называются `reportedPro` / `reportedLocked`: это утверждения провайдера, а не самостоятельная проверка личности, статуса конкретной карты или состава на её начало. Alias 184620877 — `kasane`; сопоставление выполнено по числовому ID, не нику. Историческая team_id для 94054712 равна 8944337 и сохранена как есть: старый team tag не подменяет native team карты.

`knownByAt` — время архивного capture, не время создания аккаунта или начала членства в команде. Проверены exact original URL, CDX digest, Memento-Datetime, encoded/decoded SHA-256, gzip/UTF-8 и часы. Разрешены только фиксированный HTTPS endpoint и его вариант с пустым `?`; произвольные query/host/credentials запрещены. Из тысяч строк сохраняются только десять запрошенных аккаунтов: ID, Steam64, зарегистрированный alias и три provider assertions. Аватары, profile URL, country, activity/login fields и raw bodies не коммитятся.

## Отдельная проверка identity ledger

[Снимок реестра](evidence/s3-01-ti12-identity-ledger.json) получен в `REPEATABLE READ` с `SET TRANSACTION READ ONLY`, через существующий `readAccountEvidence` для десяти ID. Время снимка **2026-10-31T22:54:20.903Z**, revision **0**: `players=0`, `player_account_evidence=0`, `player_external_accounts=0`. Это состояние конкретной локальной базы на указанное время, не утверждение об отсутствии внешних identity evidence. Source/reference strings заменены SHA; карта и исходный набор observations связаны хешами.

Pure review использует существующий `resolveIdentity` с cutoff карты. Provisional, null/late-known claims не повышаются до verified; conflicting/rejected claims и повтор одного canonical player в двух аккаунтах сохраняются как препятствия. Новые claims из registry flags или aliases не создаются. Итог: source accounts **10/10**, verified canonical accounts **0/10**, требуют подготовки связей **10**. В отчёте отдельно остаются map-specific lineup known-at, side/series/patch evidence и широкий frozen cohort с четырьмя окнами. `verifiedMapLineups=0`, `trainingExamples=0`, `strictDatasetStatus=unavailable`, `trainingReady=false`, `deployable=false`.

## Воспроизведение

```powershell
pnpm cohort:identity --out reports/new-ti12-identity-evidence.json
pnpm test:fixtures
```

CLI проверяет SHA выбранной карты по предыдущему manifest и frozen ledger, использует фиксированное окно 2023 года и первый возвращённый архив. Обычно два запроса, общий budget 6 attempts, timeout 20s, pacing 1s, максимум две попытки на request, Retry-After/cooldown; redirects не следуются. Отчёт создаётся с `wx`, existing path/неверные аргументы отвергаются до сети. DB connection отсутствует: повторный запуск проверяет **сохранённый ledger**, не текущее состояние БД; его timestamp/revision/SHA явно записаны. Новый ledger требует нового read-only capture с новой provenance, прежние evidence artifacts не переписываются.

Exit 0 означает полное получение source accounts, **не** готовность canonical links или dataset; 3 — неполное получение, 2 — аргументы/existing output, 1 — локальная ошибка. Финальный live capture: 2 HTTP200, exit0, 10/10 accounts. Preliminary discovery: 3 CDX + 2 snapshots, все HTTP200. Всего 7 прямых HTTP200, без timeout/redirect; web search отдельно. DB/quota counters не изменены.

- [Live report](evidence/s3-01-ti12-registry-evidence.json), [SHA manifest](evidence/s3-01-ti12-registry-evidence.manifest.json), [bounded probes](evidence/s3-01-ti12-registry-probes.json).
- Независимая проверка preliminary raw bytes финальным parser совпала с live payload/projection SHA. Node-тест воспроизводит identity review из сохранённых projections и ledger без сети. Полная проверка CDX/Memento требует raw body из ignored диагностики либо нового архивного fetch.
- Report SHA: `bc8313032457db397f07789e87a7a02b453d1ad158f084579fe1448a9abd7219`; review fingerprint: `ef56c58559874dcc809533c4bf1b316a2d3018ea1b9a285cddc735cc25dc9f05`.

## Следующий шаг

Этот шаг выполнен в [identity provision checkpoint](S3_01_IDENTITY_PROVISION.md): созданы10 отдельных canonical players и dated claims/aliases; replay0 inserts, canonical coverage10/10. Приведённый выше ledger revision0 остаётся историческим снимком до записи. **Следующий шаг S3-01 — pre-start lineup evidence карты7378530387**, затем side/series/patch и широкий cohort. Post-draft дополнительно требует dated hero proof; source flags/aliases не подтверждают actual map lineup.

Не продолжать поиск «отсутствующего» 184620877: source observation уже найден. S1-07, v8 S1-08 corpus gate и S3-01 открыты; S3-02 автоматически не начинается. Следующая модель: **GPT-6 Astra · Extra High**, выбор вручную.
