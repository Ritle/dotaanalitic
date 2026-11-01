# S1-08 — проверенная регистрация серий

На 2026-11-01 после исторического расширения **34 из36 локальных pro-карт связаны с26 сериями OpenDota**. Для двух карт source `series_type=3` не поддерживается текущей reviewed policy: связь остаётся unknown. Первый checkpoint ниже описывает прежние16 карт/8 серий; историческая партия добавила18 серий. Общий corpus gate, S1-07 и S3-01 остаются открытыми. Это группировка карт для последующей проверки выборок, а не прогноз серии или доказательство состава до старта.

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

Поддерживается только source enum `series_type=1 → best_of=3`, `2 → 5`; 0, 3, null и неизвестные значения блокируются. Значения сверены с [документацией enum Dota2.SeriesType библиотеки node-dota2](https://github.com/Arcana/node-dota2#dota2seriestype--enum). Это ограниченный decoder policy, а не догадка по числу карт. Больше best_of известных карт — конфликт; меньше best_of не доказывает неполноту или завершение серии.

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

Следующий точный шаг **S1-08**: сверить106 unresolved numeric account IDs исторических карт с уже сохранёнными proPlayers/identity sources. Сначала inventory/source SHA/time/conflicts; затем только подтверждённые связи через существующий accounts:current preview/apply и штатный reimport. Не объединять людей по nickname и не переносить нынешнее подтверждение в прошлое. Две unsupported series остаются unknown до отдельной проверки enum3, но не блокируют независимый identity slice. Для следующей задачи — **GPT-6 Astra · High**, модель владелец выбирает вручную.
