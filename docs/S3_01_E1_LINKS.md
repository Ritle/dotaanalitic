# S3-01 E1 — канонические игроки и серии warmup

Дата: 2026-11-02. Продолжение [импорта 196 карт](S3_01_E1_IMPORT.md) по неизменному [E1 протоколу](S3_01_E1_PROTOCOL.md). Это подготовка исследовательского корпуса, не публикация модели или оценка будущего holdout.

## Идентичности

31 из 32 неразрешённых numeric account IDs присутствует в двух ранее сохранённых OpenDota `/proPlayers`. Проверены SHA файлов и raw payload, единственность записи и равенство `Steam64 = 76561197960265728 + account_id`; подготовка проходит через `prepareCurrentAccounts` и `IdentityProvisioner`. Совпадения никнеймов, текущие команды и recent-member flags не участвуют в выборе идентичности.

Account223342537 отсутствует в обоих реестрах. Штатный клиент получил `/players/223342537` одним HTTP200 при лимите3 attempts. Отдельная policy `reviewed-current-profile-v1` проверяет endpoint, payload SHA, числовой account/Steam64 и source clocks. Профиль подтверждает текущую связь аккаунта; pro-статус и участие в карте подтверждаются отдельно исходной картой. Alias сохраняется только как подпись, а не как ключ объединения людей.

Current identity proofs получают `knownAt=fetchedAt` исходного наблюдения2026 года. Даты карт2025 года не подставляются вместо этих clocks; историческая доступность состава до старта не создаётся.

## BO1: подтверждение источником и policy v3

Прежний preview policy v2 отклонил пять групп с явным `series_type=0`:951232,951246,951258,951274,951288. [Официальный Valve GetLeagueData лиги17765](https://www.dota2.com/webapi/IDOTA2League/GetLeagueData/v001?league_id=17765&delay_seconds=0) вернул HTTP200. Во всех пяти случаях совпали numeric series ID, map ID и неупорядоченная пара team IDs между OpenDota receipt, `series_infos` и единственным league node; у узла `node_type=1`.

`ELeagueNodeType.BEST_OF_ONE=1` определён в ранее сохранённом [protobuf revision5315698](https://github.com/SteamTracking/Protobufs/blob/531569870d2d1ff08e163e6845bd6ef0e45dfabc/dota2/dota_gcmessages_common_league.proto), SHA повторно проверен. Это стороннее зеркало протокола, не репозиторий Valve. Два enum различны: значение source series_type не копируется непосредственно в best_of. [Source evidence](evidence/s3-01-e1-series-source.json) содержит реальные clocks, SHA и все94 сопоставления.

Policy `reviewed-opendota-series-v3` добавляет только явное `0 → BO1`, сохраняя `1 → BO3`, `2 → BO5`, `3 → BO2`. NULL, отсутствующий ключ и неподдерживаемые значения остаются blocked. Вторая карта в BO1, противоречивые типы, разные команды/лиги, неподтверждённые исходы и более поздние receipts блокируют всю группу. Никакого определения формата по числу локальных карт нет.

В официальном ответе93/94 группы имеют единственный соответствующий node. Для954249 есть согласованный `series_infos` с type2, обоими team IDs и всеми четырьмя локальными map IDs, но отдельный node отсутствует. Это явно отражено в evidence, не выдаётся за полное покрытие. Проверка этой BO5 использует ранее поддержанный decoder и штатные receipt/outcome gates; наличие полной удалённой серии по-прежнему unknown. Новые winner/status/map-number/knownAt из ответа Valve не импортируются.

Новая policy меняет fingerprint pending preview: оба старых плана сохранены, для применения подготовлены новые. Уже применённые batches должны воспроизводиться по прежним fingerprints. SQL001–022, контракт API и зависимости не менялись.

## Применение и проверка

Через existing IdentityProvisioner созданы32 players/account proofs/aliases; повтор каждой партии дал already_applied и0 записей. Число игроков/proofs165→197, identity revision330→394. Затем два reviewed v3-плана зарегистрировали94 серии (50+44):5 BO1/56 BO2/31 BO3/2 BO5. Новые серии имеют status/scheduled_at NULL, batch knownAt NULL. Повтор обоих batches и трёх прежних v1/v2 batches не изменил данные; прежние результаты точно совпали.

Штатный IngestionService повторно обработал196 прежних SHA-bound observations без HTTP:196 изменений, у каждой карты data revision выросла ровно на1. Ещё один проход дал196 duplicate при неизменных counts/content/revisions и quality fingerprint. OutcomeVerifier заново подтвердил196 исходов. Старые36 maps полностью сохранены; у всех232 карт сохранены исходы и прежние map/player facts, кроме явно разрешённых player/series references. Все прежние receipts сохранены.

| Показатель | До | После |
|---|---:|---:|
| Pro maps / slots | 232 /2320 | 232 /2320 |
| Разрешённые player slots | 1725 | 2320 |
| Players / account proofs | 165 /165 | 197 /197 |
| Canonical series / batches | 28 /3 | 122 /5 |
| Receipts / quality assessments | 547 /310 | 743 /506 |
| Field observations / knownAt nonnull | 6818 /0 | 11129 /0 |
| Patches / datasets / models | 0 /0 /0 | 0 /0 /0 |

Новый quality report: outcome/players/heroes/teams/series232 eligible из232; canonical conflicts0. Timeline231 unknown/1 missing/0 verified; patch/lineup-knownAt/role warnings остаются у232 карт. Strict pre/post preview после этого расширения не пересчитывался: прежний36/0 checkpoint не выдаётся за текущую выборку232.

[Manifest](evidence/s3-01-e1-links.json) содержит before/after counts, per-map results, числовые account IDs, series mappings, ссылки/SHA18 входных файлов и11 code artifacts. Полные raw observations и планы остаются в ignored `.tools`, публичный manifest не содержит raw профили/чат или секреты. Его SHA не заменяет локальные исходные файлы для exact-byte replay. Запуск: `node --env-file-if-exists=.env .tools/s3-01-e1-complete-links.mjs identities|series-preview|series-apply|reimport`; каждый режим запускался отдельно и сохранял новый exclusive output. Прежние файлы checkpoint не перезаписывались; повтор этих команд с теми же путями намеренно отвергается.

59 disposable PostgreSQL tests PASS: series provision16 (три новых BO1), identity provision22, importer14, dataset-series7. Red-прогон до исправления воспроизвёл3 BO1 ошибки и ожидаемое несовпадение версии policy. Frozen install, typecheck, build и22 migration checksum checks PASS. Первоначальный `pnpm test` завершился двумя CLI timeout20s под параллельной нагрузкой; последовательный повтор всех505 unit tests PASS, лимиты времени и код тестов не ослаблялись: `pnpm --workspace-concurrency=1 -r --if-present test --maxWorkers=1 --no-file-parallelism`. Сборка/тесты используют установленный pnpm10.19.0 и COREPACK_HOME=.tools/corepack; shell PATH сам pnpm не содержал. Default sandbox блокировал local PG EACCES, DB/source действия выполнены разрешённым запуском; spawn EPERM не возникал. Browser/API E2E/Python не повторялись, сервисы не перезапускались, push/deploy не выполнялись.

Будущий holdout02–09.11 и snapshot10.11 03:00 МСК не меняются. E1 метрики до snapshot не рассчитываются; patch/as-of/quality gates strict prediction остаются открытыми.

Следующий срез — executable E1 collector/scoring guard с привязкой к frozen plan/SHA и отказом от раннего расчёта. По CODEX_MODEL_ROUTING.md для temporal/ML boundary рекомендуется GPT-6 Astra · Extra High (если доступно), иначе High. Это совет владельцу, не автоматическое переключение.
