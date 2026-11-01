# S1-08 — привязка участников по числовым аккаунтам

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

Следующий точный шаг **S1-08**: проверить numeric profile evidence для оставшегося account `1150772339` через именованный OpenDota client; при наличии source-bound Steam32/Steam64 подготовить отдельный reviewed proof, при отсутствии сохранить unknown. Не подменять registry source профилем или ником. Затем — реальное покрытие patch/as-of context и широкий corpus. Рекомендация для следующего identity/source шага: **GPT-6 Astra · High**.
