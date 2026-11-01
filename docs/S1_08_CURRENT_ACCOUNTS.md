# S1-08 — привязка участников по числовым аккаунтам

**Актуальный результат после исторического расширения:** все165 source account IDs на36 pro-картах разрешены;360/360 player references, complete canonical players36/36. Ниже сохранён первый checkpoint малой16-map выборки; новый106-account checkpoint приведён в конце. Это текущая ретроспективная идентификация, не доказательство lineup до старта.

2026-11-01: на 16 локальных pro-картах найдено 50 разных account ID. У 28 не было canonical identity; это делало player references неполными на 12 картах. Два сохранённых ответа OpenDota `/proPlayers` содержат согласованные Steam32/Steam64 для 27 из них. После review, регистрации и штатного reimport полные player references есть у **14 из 16 карт** (было 4).

Аккаунт `1150772339` отсутствует в обоих снимках registry. Карты `9056685103` и `9056844521` остаются неполными. Отсутствие строки не означает, что игрок не профессиональный, не существует или перестал играть. Никнейм, текущая организация и вычисляемая формула Steam64 не заменяют отсутствующий source proof.

## Реализация

`prepareCurrentAccounts` читает исходные bytes `/proPlayers`, проверяет SHA, endpoint/schema, уникальность аккаунтов и явно выбранные numeric IDs. Нынешний team_id не участвует в выборе: свободные агенты и игроки других организаций не теряют историю. Одинаковый ник не объединяет разные аккаунты. Steam64 должен присутствовать в ответе и согласовываться с Steam32; отсутствующее значение не синтезируется. Любой отсутствующий выбранный аккаунт, дубликат, некорректный ID/alias/clock блокирует весь batch.

Новая policy `reviewed-current-accounts-v1` не содержит команд. Существующий `IdentityProvisioner` повторно проверяет canonical/legacy/conflicting links, stale fingerprint и атомарно добавляет players/account proofs/alias observations. Team/roster/map/context записи здесь не создаются. Apply/replay сохраняет старые labels и подтверждённые ссылки; неоднозначности не разрешаются автоматически.

`knownAt = fetchedAt` выбранного снимка, `eventAt = null`. Для этого применения это **2026-11-01T15:50:43.622Z**, позднее октябрьских карт. Более ранний снимок используется как сверка числовой пары, а не как основание менять дату proof. Импортер может использовать текущую identity для ретроспективной описательной статистики; строгий as-of resolver исключает новые доказательства для прежних дат. Это не доказательство состава конкретной карты до старта.

## Воспроизведение

Файл выбора содержит только явно проверенные аккаунты и момент review:

```json
{"accountIds":["9403474","196400041"],"reviewedAt":"2026-11-01T18:40:00.000Z"}
```

В реальном запуске reviewedAt должен быть не раньше fetchedAt источника и не позже настоящего времени. Источник — сохранённый `current_catalogue_capture`; функция использует его registry, без изменения teams.

```powershell
pnpm accounts:current preview .tools/source.json .tools/selection.json .tools/account-plan.json
pnpm accounts:current apply .tools/source.json .tools/selection.json .tools/account-plan.json <SHA256-файла-плана> .tools/account-result.json
```

Output всегда новый файл; CLI резервирует его до изменений БД. Apply связывает исходные bytes, review, SHA файла плана и fingerprint текущего состояния. Повтор того же успешно применённого плана идемпотентен; новый конфликт блокирует даже replay. Если отчёт не сохранился после commit, CLI явно сообщает об этом. После регистрации существующий `history:current` повторно обрабатывает SHA-bound captures и обновляет ссылки игроков на картах.

Для этого checkpoint: выбран snapshot S1-21 (его SHA совпал с уже сохранённым evidence); numeric пары дополнительно сверены с S1-12. Созданы 27 players +27 account proofs +27 aliases. Replay: 0 записей. Registry revision62→116; всего players/proofs/aliases58. Организации10, серии8 и карты16 не изменились.

Reimport двух прежних history captures: 10+10 обработок с4 совпадающими картами, в каждом4 duplicate/6 новых assessment; ошибок0. Replay обоих:10+10 duplicate, revisions неизменны. Assessments41→53, receipts62→74. Old evidence сохранены, новых provider HTTP запросов0. Это replay ранее выполненных live audits, не новая live coverage проверка.

## Результат и ограничения

| Проверка | До | После |
|---|---:|---:|
| Полные player references карт | 4/16 | 14/16 |
| Неразрешённые уникальные account ID | 28/50 | 1/50 |
| Outcome/heroes/teams/series eligible | 16/16 | 16/16 |
| Canonical conflicts | 0 | 0 |
| Verified draft timeline / canonical patch | 0/16 | 0/16 |
| Строгие eligible training maps, оба stages | 0 | 0 |

Datasets0/active models0, field observations с known_at0; исходные2 prospective schedule observations не менялись. `trainingReady:false`, `deployable:false`, probabilities unavailable. Полнота player references не означает проверенные роли или заранее известный lineup.

Проверки: frozen install/typecheck/441 unit/build;35 PG (21 identity provision, включая2 новых, и14 importer). Семь новых pure cases покрывают numeric selection вне организации, namesakes, отсутствие/дубликаты, SHA/endpoint/clocks, несогласованный или отсутствующий Steam64, пустые aliases/границы ID. Первый запуск упал до реализации; затем одна проверка ожидала более позднюю ошибку дубликата, хотя общий source schema уже отклонял его. Проверка поправлена без ослабления валидации. SQL001–022/dependencies/lockfile/API/UI не менялись; E2E/Python/backtest не выполнялись.

Evidence: [новый quality report](evidence/s1-08-accounts-quality.json), [manifest, SHA, replay и strict previews](evidence/s1-08-current-accounts.json). Исходные captures и полные отчёты остаются локальными ignored файлами.

Прежний следующий шаг account1150772339 выполнен отдельно: [profile identity](S1_08_PROFILE_IDENTITY.md). Его источник и часы не менялись при историческом расширении.

## Историческая выборка: 106 дополнительных аккаунтов

После импорта20 исторических карт оставались106 unknown account IDs на19 неполных картах. Действующий resolver подтвердил отсутствие существующих current links. SHA-bound S1-12/S1-21 `/proPlayers` дают согласованные числовые пары Steam32/Steam64 для83 IDs. Existing `accounts:current` preview83 ready → атомарные83 players/proofs/aliases; повтор0 writes. Источник proof — S1-21 snapshot с knownAt2026-11-01T15:50:43.622Z, ранний snapshot только подтверждает совпадение числовых пар.

Остальные23 отсутствуют в обоих registry snapshots. Именованный OpenDota client проверил `/players/{id}` с общим пределом69 attempts: реально23 HTTP200, retries/errors0. Все23 ответа предоставили согласованные account ID/Steam64 и пригодный display alias. Они обработаны через существующую `reviewed-current-profile-v1` и IdentityProvisioner: отдельный source URL/knownAt=fetchedAt, fresh preview перед каждым apply (registry revision меняется), индивидуальный replay0 writes. Профиль не переименовывается в registry и не утверждает pro status/роль/состав. Ни nickname joins, ни cross-provider person merges не выполнялись.

Всего106 новых players/proofs/aliases, current registry59→165/revision118→330. Старые59 player/proof/alias rows сохранены по fingerprint, identity provision не изменял карты/участников/receipts. Штатный importer перечитал исходный SHA-bound20-map capture без HTTP:19 изменений,1 duplicate; контрольный replay20 duplicate с неизменными состоянием и quality fingerprint. Подтверждены неизменность всех исходов/героев/команд/series и старых player links; только151 ранее пустая player reference заполнена. Теперь все165 различных source accounts разрешены,360/360 слотов; player completeness17→36/36, canonical conflicts0.

Working maps36/teams35/series26/assessments112/receipts153, datasets0/active models0, upcoming observations2/known field observations0. Outcome/players/heroes/teams36/36, series34/36; unsupported type3 на двух картах остаётся unknown. Все106 новых identities недоступны historical resolver на2026-10-01 (позже всех20 исторических карт, но раньше новых proofs). Поэтому strict pre/post preview всё ещё36 candidates/0 eligible; `ACTUAL_LINEUP_INCOMPLETE` в strict context не противоречит полной текущей descriptive идентификации. Никакого обучения, активации или ослабления gates.

[Manifest с source SHA, mappings, replay и strict previews](evidence/s1-08-historical-accounts.json), [качество](evidence/s1-08-historical-accounts-quality.json). Full source profiles/registry/планы/replay/helper остаются в ignored `.tools`; exact-byte replay требует этих локальных файлов. Production code/SQL/dependencies/API/UI не менялись; используются уже проверенные boundaries. Browser/Python/backtest не запускались.

Следующий точный шаг **S1-08**: проверить первичный источник значения `series_type=3` для903379/903582 и только при подтверждении расширить tested decoder. Не выводить формат по числу локальных карт, не вводить прогноз серии и не переписывать старые evidence. Затем canonical patch/as-of/corpus gates по плану. Рекомендована **GPT-6 Astra · High**, выбор модели вручную.
