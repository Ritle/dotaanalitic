# S0-05 — Canonical identity и целостность состава

Внутренний вертикальный срез: append identity/alias evidence → PostgreSQL → чистый resolver → importer / история участников / lineup на cutoff. Реализация в `packages/contracts/src/identity.ts` и `packages/db/src/identity*.ts`; importer использует общий resolver. Нет нового публичного endpoint, review UI, прогнозов или автоматических объединений игроков.

## Identity и aliases

`players.id` остаётся канонической личностью, `teams.id` — организацией. `player_account_evidence` (migration 010) хранит неизменяемые claims с player ID, provider, нормализованным Steam32, status, source/evidence и отдельными event/known/fetched. Провайдерские labels OpenDota/STRATZ относятся здесь к одному **явно нормализованному Steam32 namespace**; подключение STRATZ по-прежнему выключено, произвольный сырой provider ID сюда не принимается.

`IdentityRepository.appendAccountEvidence` не создаёт и не объединяет людей; FK требует существующий canonical player. Только verified claim с evidence позволяет приписать аккаунт человеку. Provisional/rejected сами по себе не подтверждают связь. Два verified claims одного Steam32 на разных людей — `conflict`, включая разные провайдеры. Evidenced rejection существующего verified claim также даёт конфликт. «Последний provider победил» и автоматического разрешения спорных связей нет; ручной review/supersession остаётся отдельной задачей S5-03.

Одинаковые ники/aliases не участвуют в resolver. `appendAlias` сохраняет display history отдельно, идемпотентно и без смены canonical ID; `aliasesAsOf` требует known_at/evidence. Старым aliases не добавляется историческая дата. Повтор одного proof не создаёт новую запись; конкурентные claims сериализуются по Steam32. SQL triggers запрещают UPDATE/DELETE proofs/aliases и повышают `identity_registry_state.revision` при новой evidence. Registry revision также меняется при legacy external-link изменениях. Новых внешних библиотек нет.

Policy `verified-steam32-v1` разделяет current descriptive identity и identity as-of. Для as-of нужен доказанный `known_at <= cutoff`, event не позже cutoff. Fetch в 2026 с датированным evidence из 2023 допустим; fetch без такого evidence не подтверждает раннюю известность. Current legacy `player_external_accounts` учитываются только для текущего описательного импорта: `verified_at` не превращается в public historical known_at. Проверка whitespace/verification сохраняет неподтверждённые legacy записи вне resolver.

## Интеграция импорта

Normalizer `opendota-map-v2-identity` читает ledger + допустимые legacy links через общий resolver, сохраняет policy/status/observation IDs в `identity_resolution` field observation и fingerprint контекста. Unresolved/conflicting accounts не получают новую canonical identity; два аккаунта одного человека на одной карте не создают два места в пятёрке. Импорт не присваивает known_at фактическому post-game lineup.

Уже сохранённые `match_players.player_id` не переписываются при добавлении proof: это прежняя canonical проекция. Для актуальной identity-aware истории используется `historyForPlayers`, который разрешает `source_account_id` заново с evidence на cutoff; старую проекцию нельзя считать достаточным identity gate. При явной смене уже известного canonical player импорт сохраняет прежний conflict behavior. Frozen prediction/dataset snapshots не меняются. Наличие proof не запускает массовый reimport.

## История и состав

`historyForPlayers({playerIds,cutoffAt})` возвращает **retrospective_participation** cohort, а не исторически заранее объявленную пятёрку. Только положительно pro-карты, strictly earlier start, подтверждённый non-null outcome и завершение не позже cutoff; outcome/telemetry не возвращаются. Это reader участия для описательной истории, **не** готовый feature builder/label availability gate.

История не фильтруется по организации, не join-умножается на количество account proofs или aliases. Несколько подтверждённых аккаунтов одного человека на разных картах продолжают одну карьеру. При одновременном повторе canonical человека внутри карты оба слота становятся неизвестными. Native slots и стороны сохраняются; отсутствующего пятого участника не выдумываем. Только complete five может передаваться в `rosterCoplay`; fingerprint не зависит от организации и ролей. Pair/exact-five считаются отдельно от истории тега, никаких штрафов за замену.

`players[].mapCount` равен 0 для подтверждённого игрока без наблюдённых карт и NULL для неизвестной/неоднозначной истории; `nRaw` — число возвращённых уникальных карт, не «полнота карьеры». Возвращаются missing/conflict warnings, identity policy/revision, map revisions, cutoff и IDs доказательств. Все чтения истории идут в repeatable-read snapshot. Наличие такой истории не закрывает историческую corpus coverage S0-08/09/S1-08.

`lineupAsOf` использует strict S0-04 observations, а не current-members/roster-period flags. Десять native slots распределяются 5+5; неизвестный/несуществующий canonical ID оставляет side incomplete. Роль проверяется отдельно: только `basis=confirmed` и confidence NULL (не выдумывается) либо 1 дают rolePos. Любая estimated роль, даже с confidence 1, и confirmed с confidence <1 дают `rolePos:null`; исходная оценка сохраняется в `roleEvidence`. Это политика доказательств, а не калиброванный вероятностный порог. Duplicate positions на одной стороне и несовпадение role/player дают warnings и неизвестную роль. Перестановка ролей не меняет fingerprint игроков.

Manual scenario lineup остаётся авторитетной гипотезой в будущих S2 flow; это не официальное объявление исторического состава. Unknown stage/role/lineup не заменяются текущими данными.

## Проверка и эксплуатация

2026-10-31 PASS: frozen install/typecheck/build, 96 unit; identity PG 12, temporal PG 9, ingestion/queue PG 17, auth PG/CLI 11, baseline PG 4; Node fixtures 10. Миграция 010 APPLIED, повтор 10 SKIP; historical checksums, docs links/git diff проверены. Compiled Node smoke в рабочей БД: 10 stored accounts, 0 verified identities, 0 proofs/aliases, identity revision 0. E2E/Python/Docker/remote CI в этой задаче не запускались. Derived caches должны включать обе ревизии: identityRevision и map dataRevision.

`pnpm test:identity` — real PG16/CREATEDB, случайная временная БД; `pnpm test` включает pure identity/lineup tests. Synthetic people/maps/aliases не записываются в рабочую БД. CI включает identity suite. До исправления importer regression воспроизводил отсутствие связи из нового ledger; после подключения resolver проверяет и успешный import, и cross-provider conflict.

Миграции 001–009 неизменны. После применения 010 следующий SQL — 011+. Перед запуском нового API/worker выполнить `pnpm db:migrate`; legacy current links сохраняются, но новой исторической известности не получают. Реального identity evidence или verified corpus в этой задаче не создаётся.

Следующая задача: **S0-06 — матчевый контекст и валидность героев**; рекомендуемая модель **GPT-6 Astra · High**.
