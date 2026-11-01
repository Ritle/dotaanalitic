# S1-08 — последний неразрешённый аккаунт текущего корпуса

На 2026-11-01 завершена проверка numeric identities всех 50 аккаунтов, встречающихся на 16 локальных pro-картах. Аккаунт `1150772339`, отсутствующий в двух сохранённых `/proPlayers`, подтверждён отдельным ответом `/players/1150772339`: источник сам прислал Steam32 и Steam64 `76561199111038067`, их числовая связь проверена. После регистрации и штатного reimport player references полны у **16/16 карт**, ранее14/16. Это закрывает пробел идентификации в текущей малой выборке, но не общий corpus gate или model readiness.

## Источник и пределы доказательства

Именованный OpenDota client с durable quota, timeout/retry и бюджетом3 attempts выполнил2 попытки: одна transport `source_network_error`, затем один HTTP200. FetchedAt **2026-11-01T18:50:07.066Z**, raw payload SHA `3b199a111de0dbe479d13fcf1e9b28373d348f9c07377ed8bece4cb6f6bdc081`. Исходные bytes сохранены локально; повторных сетевых обращений для review/apply/reimport не было.

`name=null`; исходный `personaname` сохранён только как display alias. По нику не выполняются merge, сверка человека с заявкой PandaScore или определение команды. Профиль не доказывает pro status, роль, участие в будущей карте или lineup до старта. Положительный pro/outcome статус двух затронутых карт был установлен отдельным importer gate ранее.

Отдельная policy **reviewed-current-profile-v1** сохраняет точный URL профиля. Endpoint, capture.accountId, requested selection, payload account_id и supplied Steam64 должны согласоваться. Ровно один аккаунт на batch; null profile, недостающий Steam64, пустой alias, неверные SHA/даты или несколько выбранных IDs блокируют применение. Профиль никогда не выдаётся за registry `/proPlayers`.

`knownAt=fetchedAt`, `eventAt=null`. Новое доказательство недоступно до октябрьских карт. Оно разрешает текущую ретроспективную идентификацию участников, но не создаёт историческую доступность состава. Применяется существующая атомарная проверка canonical/legacy conflicts и stale fingerprint; replay идемпотентен, старые proofs не меняются. Новых SQL миграций нет.

## Команды

```powershell
pnpm profile:capture 1150772339 .tools/profile-capture.json
pnpm accounts:current preview .tools/profile-capture.json .tools/profile-selection.json .tools/profile-plan.json
pnpm accounts:current apply .tools/profile-capture.json .tools/profile-selection.json .tools/profile-plan.json <SHA256-файла-плана> .tools/profile-applied.json
```

Selection: `{"accountIds":["1150772339"],"reviewedAt":"<прошедшее UTC время с миллисекундами>"}`. Review не раньше fetchedAt. Все output файлы новые; capture сам ничего не записывает в identity registry. `observed` в capture означает наличие profile.account_id, не автоматическое разрешение на применение: offline preview проверяет остальные поля. Операция apply связывает source/review/plan SHA с повторной проверкой состояния БД.

## Фактический результат

- Созданы1 player,1 account proof,1 alias; повтор того же плана —0 записей. Registry revision116→118, players/proofs/aliases58→59.
- Повторно обработан проверенный S1-21 history capture:10 карт,2 новых обработки (`9056685103`, `9056844521`),8 duplicate,0 ошибок. Replay10 duplicate, revisions неизменны.
- Maps16/series8/teams10 прежние; assessments53→55, receipts74→76. Outcome/players/heroes/teams/series eligible16/16, canonical conflicts0. Timeline/patch/roles/pre-start lineup остаются неподтверждёнными.
- Все50 source accounts разрешены; старые identity proofs сохранены. Datasets0/active models0/known field observations0, prospective source observations2.
- Строгие pre-match/post-draft previews остаются unavailable/0 eligible при новом snapshotAt после получения профиля. Проверка использует текущий снимок доказательств, а не старый snapshot, который ещё не включал профиль.

[Quality report](evidence/s1-08-profile-quality.json) и [manifest с provenance, SHA/replay/strict previews](evidence/s1-08-profile-identity.json). Старые evidence не перезаписаны. Полные raw bytes и рабочие отчёты остаются ignored в `.tools`.

## Проверки и следующий шаг

PASS: frozen install/typecheck/448 unit/build,36 PG (22 identity provision +14 importer). Целевой запуск50 tests включает эти36 PG и14 pure account/profile cases;7 profile cases и1 PG новые. Сначала regression suite упал на отсутствующем модуле, затем все целевые проверки прошли. Тесты проверяют null/missing/inconsistent profile, неверные endpoint/account/selection/hash/clock, alias fallback, replay и отсутствие ранней identity. SQL001–022/dependencies/lockfile/API/UI не менялись; E2E/Python/model backtest не запускались.

Следующий точный шаг **S1-08 broad corpus quality**: подготовить ограниченную стратифицированную выборку pro-карт нескольких турниров и периодов с явным HTTP бюджетом; начать с существующих corpus/source audits, исключить уже импортированные IDs, подтвердить source/pro/outcome coverage перед записью. Текущие16 карт охватывают2 лиги,1 месяц и только provider patch60; это недостаточное разнообразие. Канонический patch, pre-start lineup/draft availability и реальные temporal model gates остаются отдельными незакрытыми условиями. Рекомендована **GPT-6 Astra · High** для source/temporal проверки.
