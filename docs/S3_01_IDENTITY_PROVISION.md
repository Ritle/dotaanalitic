# S3-01 — канонические связи десяти аккаунтов

2026-11-01: **для десяти аккаунтов выбранной карты7378530387 созданы десять отдельных канонических записей игроков**. Числовые связи и история имён сохранены с архивным evidence. Повторное применение плана выполнило0 вставок. Identity coverage для этой карты выросло с0/10 до10/10; verified map lineups/training examples остаются0, S3-01 открыта.

## Основание и пределы проверки

[Reviewed batch](evidence/s3-01-ti12-reviewed-accounts.json) связан SHA с предыдущими [registry evidence](S3_01_IDENTITY_EVIDENCE.md), картой, raw payload и проекцией десяти account IDs. Для каждого проверено точное соответствие Steam32/Steam64 и отсутствие конфликта с существующими каноническими записями. Это отдельное решение по политике `reviewed-single-account-v1`; provider flags сами не вызывают создание verified claims. Никнеймы — подписи и alias history, не ключ поиска людей. Разные аккаунты не объединяются; доказательство непрерывного владения аккаунтом или несколько аккаунтов одного человека здесь не устанавливаются.

`eventAt=null`: дата создания аккаунта/начала связи неизвестна. `knownAt=2023-04-11T21:06:28.000Z` — подтверждённое наличие числовой association в архиве. `fetchedAt=2026-10-31T22:57:24.392Z` — получение архивного тела. `reviewedAt=2026-10-31T23:31:28.791Z` — выполнение этой проверки. Время review не переносится в прошлое; claim evidenceRef содержит SHA review и payload вместе с account ID. Исторический alias сохранён отдельно; existing display name при повторном использовании игрока не заменяется.

## Запись и защита от конфликтов

`IdentityProvisioner.preview` выполняет read-only repeatable-read чтение. План учитывает numeric fields `players`, append-only claims и legacy links обоих поддержанных провайдеров, включая provisional/rejected записи, которые обычный verified-reader мог бы не вернуть. Единственный exact numeric target можно использовать повторно; nickname equality игнорируется. Несколько targets, чужой Steam64, неподтверждённая/отклонённая связь или один canonical player для двух выбранных аккаунтов блокируют весь batch.

Apply связывается с SHA preview-файла и заново проверяет fingerprint/revision БД. Изменение состояния требует нового preview. Полностью выполненный тот же review допускает повтор с прежним планом и0 вставок. Сначала берутся упорядоченные account advisory locks, затем краткие `SHARE ROW EXCLUSIVE` locks четырёх identity tables: это ограниченная offline операция для персонального приложения. Lock timeout5s, statement timeout15s; при конфликте или ошибке все domain inserts и revision updates откатываются. Append использует прежний immutable boundary, вынесенный в общие transaction helpers.

Создано10 `players`,10 `player_account_evidence`,10 `player_alias_history`; registry revision выросла0→20 за счёт triggers proofs/aliases. `databaseWrites` отчёта считает эти30 новых domain rows, revision updates показаны отдельно. Legacy links0; существующие match_players, контекст карт, роли, патчи, датасеты и прогнозы не переписаны. После commit выполнен отдельный read-only снимок ledger и as-of review существующим `resolveIdentity`:10 verified accounts,0 conflicts/duplicates,0 remaining account-link reviews.

## Воспроизведение

```powershell
pnpm identity:provision preview --out reports/identity-preview.json
$identityPlanSha = (Get-FileHash -LiteralPath reports/identity-preview.json -Algorithm SHA256).Hash.ToLowerInvariant()
pnpm identity:provision apply --plan reports/identity-preview.json --sha256 $identityPlanSha --out reports/identity-applied.json
pnpm test:identity-provision
```

CLI использует фиксированный reviewed batch, проверяет его связь с сохранёнными source/map artifacts, ничего не запрашивает по сети. Новые источники требуют отдельного review, не произвольного JSON из API. Отчёты создаются с `wx`; existing output/неверные аргументы/неверный SHA плана отвергаются до соединения с БД. Exit0 — preview/apply выполнен,3 — blocked preview,2 — usage/existing output/missing DB config,1 — проверка/операционная ошибка. Если запись файла отказала уже после commit, CLI прямо сообщает, что БД зафиксирована, и предлагает идемпотентный повтор с новым output. Не заявляет rollback после успешного commit.

- [Исходный план](evidence/s3-01-ti12-identity-plan.json): ready,10 новых игроков, DB writes0.
- [Применение](evidence/s3-01-ti12-identity-applied.json):10 players/proofs/aliases, canonical coverage10/10.
- [Реальный повтор](evidence/s3-01-ti12-identity-reapplied.json): already_applied,0 inserts, те же canonical IDs/revision20.
- [SHA manifest и итоговые counts](evidence/s3-01-ti12-identity-provision.manifest.json). Предыдущий frozen ledger revision0 и его отчёты остаются неизменными; `cohort:identity` по-прежнему воспроизводит именно тот старый снимок.

Проверки:3 новых contract tests,13 новых PG tests,4 Node artifact/CLI tests. Проверены zero-write preview, same-nickname separation, bigint IDs, strict historical cutoff, stale plan, cross-provider и provisional/rejected conflicts, duplicate canonical target, parallel/idempotent replay, rollback после ошибки позднего alias insert и read-only final snapshot. Существующие identity/import PG suites также исполнены. SQL001–018 и dependencies/lockfile неизменны; миграция не нужна.

## Следующий шаг

Обновление следующего checkpoint: [lineup audit](S3_01_LINEUP_EVIDENCE.md) подтвердил обе регистрации на турнир и10 canonical participants; strict map lineup known-at ещё не доказан. Текущий точный следующий срез — явный retrospective context / conditional readiness, описанный там. Ниже сохранён исходный handoff этого provision checkpoint.

**Продолжить S3-01: найти и проверить источник состава карты7378530387, доступный до её начала2023-10-12T17:00:44Z, и связать подтверждённые numeric IDs с созданными canonical IDs.** Состав завершённой карты, старый team tag и совпадение ников не заменяют dated lineup evidence. Далее остаются native side/series/patch proofs и широкий frozen cohort с четырьмя временными окнами; post-draft требует датированных hero picks. Для этих десяти IDs identity provisioning завершён, повторять его как незакрытый поиск не требуется.

S3-01, S1-07 и отдельный v8 S1-08 corpus gate открыты. S3-02/features/training/activation автоматически не начинаются. Следующая модель: **GPT-6 Astra · Extra High**, выбор вручную.
