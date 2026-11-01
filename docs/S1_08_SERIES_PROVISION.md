# S1-08 — проверенная регистрация серий

На 2026-11-01 **все36 локальных pro-карт связаны с28 сериями OpenDota**. Policy `reviewed-opendota-series-v2` добавляет подтверждённый формат BO2 для `series_type=3`; последние серии903379/903582 зарегистрированы. Ниже сохранены предыдущие checkpoint16/8 и34/26 как история. Общий corpus gate, S1-07 и S3-01 остаются открытыми. Это группировка карт для последующей проверки выборок, а не прогноз серии или доказательство состава до старта.

## Контракт и запуск

После `pnpm db:migrate` (001–022) создайте конфиг с уникальными decimal-string `providerSeriesIds` (1–50) и прошедшим UTC `snapshotAt` с миллисекундами:

```json
{"providerSeriesIds":["1157928"],"snapshotAt":"2026-11-01T18:29:53.047Z"}
```

```powershell
pnpm series:provision preview .tools/series-request.json .tools/series-plan.json
pnpm series:provision apply .tools/series-request.json <fingerprint-из-плана> .tools/series-applied.json
pnpm test:series-provision
```

Каждый output должен быть новым файлом. Fingerprint — SHA канонического содержимого плана, не SHA файла JSON. Preview выполняет SELECT в repeatable-read, включая row SHARE locks существующего OutcomeVerifier. Он ничего не записывает, но не объявляет транзакцию SQL READ ONLY из-за этих блокировок.

Проверяются все **локально известные** карты каждого source series ID и все их receipts, включая received/quarantined: положительный pro/outcome gate, numeric team/league references, обе стороны без зависимости от Radiant/Dire, согласованность источников и существующих canonical series. Противоречия, неподтверждённые исходы, неоднозначные aliases, поздние receipts, отсутствие canonical references блокируют весь план. Receipt clock сохраняется с микросекундами: даже +1µs после snapshot исключается. Лимиты 500 карт/5000 receipts завершаются явной ошибкой, без усечения.

Текущая policy v3 поддерживает source enum `series_type=0 → best_of=1`, `1 → 3`, `2 → 5`, `3 → 2`; 4, null, отсутствующий ключ и неизвестные значения блокируются. Значения BO3/BO5 сверены с [документацией Dota2.SeriesType](https://github.com/Arcana/node-dota2#dota2seriestype--enum); основание для BO2 приведено ниже, для BO1 — в [E1 review](S3_01_E1_LINKS.md). `series_type` и `ELeagueNodeType` — разные перечисления. Больше best_of известных карт — конфликт; меньше best_of не доказывает неполноту или завершение серии. BO2 допускает ничью1:1, поэтому победитель серии не выводится. Исторические результаты v1/v2 ниже сохраняются; pending планы v2 требуют нового preview, уже применённые batches воспроизводятся по прежнему fingerprint.

## Подтверждение BO2 и применение policy v2

[Официальный GetLeagueData Valve для лиги16935](https://www.dota2.com/webapi/IDOTA2League/GetLeagueData/v001?league_id=16935&delay_seconds=0) возвращает для903379/903582 `series_infos.series_type=3` и соответствующие узлы `node_type=4`. Сопоставлены numeric series/map/team IDs с сохранёнными OpenDota observations; порядок команд сравнивается независимо от стороны. Всего в ответе24 однозначных соответствия3→4 и одна запись type3 без однозначного узла. Источник не объявляется полностью покрытым.

Определение `ELeagueNodeType.BEST_OF_TWO=4` взято из [дампа протокола игры, revision5315698](https://github.com/SteamTracking/Protobufs/blob/531569870d2d1ff08e163e6845bd6ef0e45dfabc/dota2/dota_gcmessages_common_league.proto). SteamTracking — стороннее зеркало, не репозиторий Valve. Revision датирован2023-08-30; это не доказательство исторического knownAt для конкретной карты. Оба использованных body получены с HTTP200 и сохранены с SHA-256. [Source manifest](evidence/s1-08-bo2-source.json) различает время сохранения файла и время события; scores0:2/1:1 имеют явный порядок source team IDs.

Новая policy меняет fingerprint новых планов; уже применённые v1 batches остаются неизменными и воспроизводятся по прежнему fingerprint. Pending v1 preview требует нового preview. Рабочий apply создал2 серии/1 batch; повтор вернул `already_applied` без новых записей. Отдельно проверен replay прежней v1 партии18 серий. Статус, scheduled_at и batch known_at новых серий NULL. Официальные sibling IDs/счёт/порядок карт в БД не переносились: на каждую новую серию по-прежнему импортирована одна карта.

Штатный reimport20 сохранённых observations:2 изменения/18 duplicate; повтор20 duplicate. Старые26 series, все match_players, исходы, герои и прежние receipts сохранены. Итог:36 карт/28 серий/3 batches/114 assessments/155 receipts, players/proofs165, identity revision330. Outcome/players/heroes/teams/series36/36, conflicts0; timeline/canonical patch unknown36. Strict pre/post36 candidates/0 eligible, datasets0/active models0; причины неизвестной серии исчезли. Позднее подтверждение identity не делает состав доступным до начала карты.

Регрессионные тесты сначала воспроизвели3 ошибки старой policy, затем прошли вместе с существующими проверками: ничья BO2 при смене сторон, третья карта и противоречивые BO2/BO3 observations. PASS: frozen install/typecheck/448 unit/build,34 PG (13 series provision +14 importer +7 dataset-series),22 migration checksum checks. SQL001–022, зависимости, UI и prediction gates не менялись; browser/Python/backtest не запускались. Новых OpenDota map HTTP0; live Valve/protobuf research не является новым audit импортированных карт.

[Manifest применения, проверки и SHA](evidence/s1-08-bo2-series.json), [качество](evidence/s1-08-bo2-quality.json). Полные body/планы/helper остаются локально в ignored `.tools`; один checkout не воспроизводит exact-byte replay без этих файлов.

Apply в короткой транзакции блокирует изменение matches/teams/leagues/receipts/series (lock timeout 5s), повторяет проверку и сравнивает fingerprint. Изменившийся план требует нового preview; частичной регистрации нет. Новая миграция 022 разрешает NULL status серии, сохраняя legacy default, и добавляет immutable `series_provision_batches`. Новые серии явно имеют status/scheduled_at NULL; map number, счёт перед картой и first pick не выводятся. `known_at` batch всегда NULL, `recorded_at` — серверное время регистрации. SQL001–021 не изменялись.

Повторный apply того же fingerprint возвращает `already_applied` и исторический результат batch, без новых записей. Поле `created` в этом ответе описывает первоначальное применение, а не число повторных вставок. Такой replay не является новой проверкой текущего состояния: для неё нужен новый preview.

Provisioner не меняет maps (`mapWrites:0`). Затем штатный importer заново обрабатывает проверенные captures и связывает карты с registry. Известное несовпадение league теперь не позволяет importer присоединить серию; legacy NULL league остаётся совместимым, новые reviewed series всегда имеют проверенную league. Старые receipts/quality snapshots сохраняются.

## Реальное применение

Использованы прежние captures S1-13/S1-21 и их SHA-bound live audits. Новых provider HTTP запросов **0**; это replay ранее полученных реальных данных, не новая live coverage audit и не синтетика. Планы reimport содержат по 10 карт с пересечением 4; итоговый N остаётся 16.

| Source series ID | Локальные карты |
|---|---:|
| 1156918 | 1 |
| 1157928 | 2 |
| 1159662 | 2 |
| 1161402 | 3 |
| 1161529 | 1 |
| 1161942 | 3 |
| 1162416 | 2 |
| 1162593 | 2 |

Все 8 групп прошли preview; применена 022, создано 8 registry rows/1 batch. Replay миграций: 22 SKIP. Reimport: 20 обработок, 0 ошибок; повтор обоих captures: 10+10 duplicate, без новых revisions. Качество series: **0 → 16 eligible**, canonical conflicts 0. Outcome/heroes/teams eligible16, players eligible4/unknown12, timeline unknown16, canonical patch unknown16. Quality replay совпал по fingerprint. Полнота удалённого состава серии остаётся unknown; группы из 1–3 карт не объявляются полными сериями.

В БД: maps16, assessments41 (было21), receipts62 (было42), datasets0, active models0, source observations2; field observations с known_at по-прежнему0. Строгие pre-match/post-draft preview: candidates16/eligible0. Пропала причина неизвестной серии, но остались недоступные as-of lineup/team/patch, а post-draft дополнительно требует hero context. Текущая полнота player references на 4 картах не равна историческому доказательству доступности состава.

Артефакты: [новый отчёт качества](evidence/s1-08-series-quality.json), [manifest с source/code SHA, registry IDs, replay и strict preview](evidence/s1-08-series-provision.json). Предыдущие evidence не перезаписаны; полные captures/планы остаются ignored в `.tools`.

## Проверки и следующий шаг

### Историческая партия после расширения корпуса

Проверены20 новых provider series IDs из SHA-bound capture [исторического расширения](evidence/s1-08-expansion-manifest.json). Новых provider HTTP запросов0. Общий preview корректно заблокирован из-за `SERIES_TYPE_UNSUPPORTED` у903379 (карта7927665228) и903582 (7928915377): source enum3 не преобразован в best_of по предположению. Остальные18 групп прошли отдельный preview без изменения policy; атомарно созданы18 canonical series и1 batch. Старые8 registry rows, все карты и receipts на этом шаге не изменились. Статус и scheduled_at новых серий NULL; known_at batch NULL.

Штатный importer повторно обработал20 сохранённых observations:18 изменённых связей/2 duplicate, затем20 duplicate при exact replay. Для18 карт data_revision выросла ровно на1. Полные map facts (кроме series/revision/ingest state/service timestamps), все player rows, старые receipts и18 нетронутых карт совпали с before snapshot; итоговый quality fingerprint стабилен при replay. База:36 карт/26 серий/2 batches/93 assessments/134 receipts; players59/proofs59/identity revision118 неизменны. Series eligible16→34, unknown2; outcome/heroes/teams36, players17. Scope новых групп — одна локальная карта на серию: полнота состава серии, номер карты и предшествующий счёт не установлены.

Strict pre/post previews по-прежнему36 candidates/0 eligible; datasets0/active models0/known field observations0.106 unresolved source accounts — следующий отдельный шаг. [Manifest с preview/replay/SHA и результатами проверок](evidence/s1-08-historical-series.json), [качество](evidence/s1-08-historical-series-quality.json). Полные планы/capture/helper находятся локально в ignored `.tools`, без них exact-byte replay нельзя воспроизвести из одного checkout. Source capture/audits предыдущего шага не перезаписаны.

Для этой партии пройдены frozen install/typecheck/unit/build,29 PG (10 series provision +14 importer +5 corpus quality),22 migration checksum checks. Production code, SQL, dependencies и UI не изменялись; browser/Python/backtest не запускались. Ни новые tests, ни weakened gates для этого применения существующих инструментов не добавлялись.

### Первый checkpoint

PASS: frozen install, typecheck, 434 unit, build; 10 новых PG случаев + 14 importer + 4 worker queue = 28 PG. Покрыты concurrent apply/replay, swapped sides, conflicting league/receipt, unsupported enum, новый sibling после preview, неоднозначные aliases, league mismatch importer и микросекундная граница. UI/Python/backtest не изменялись и не запускались. Windows spawn/store ограничения обходились разрешённым запуском вне sandbox, не заменой тестов.

Identity slice106 IDs и BO2 slice завершены: current players/series36/36. Следующий точный шаг **S1-08** — инвентаризация canonical patch/as-of evidence36 карт и6 provider patch codes через существующие границы S1-07: сопоставить сохранённые proofs, явно отделить подтверждённые интервалы от неизвестных. Не подставлять release timestamp по метке патча. Полнота IDs не создаёт исторический pre-start lineup; strict cohort/model gates сохраняются. Для следующей задачи — **GPT-6 Astra · High**, модель владелец выбирает вручную.
