# S0-02 + S0-10 — импорт одной карты и durable worker

Дата: 2026-10-31 (Europe/Moscow). Live evidence содержит исходные UTC timestamps, включая вечер 2026-10-30.

## Реализованный срез

`packages/ingestion`: общий server-side OpenDota client, нормализатор, независимые quality assessments и PostgreSQL provider budget. `packages/db`: Kysely/pg connection и typed SQL. `apps/worker`: pg-boss 12.38.0; Kysely 0.28.18 и зависимости разрешены pnpm, lockfile проверен frozen install. Старые API provider exports совместимы через re-exports shared package.

Бизнес-схема расширена **только** `007_idempotent_ingestion.sql`: source account ID отдельно от canonical player ID, receipt/reference evidence, canonical data revision, ingest state и глобальная квота. Содержимое 001–006 не изменено; 001–005 совпадают с golden. Собственная схема `pgboss` управляется lifecycle библиотеки отдельно от бизнес-миграций.

## Данные и происхождение

1. После `/matches/{id}` сначала сохраняется immutable receipt `received` с минимальной проекцией ответа и SHA-256 исходных UTF-8 bytes. Ошибка последующих catalogs/транзакции не уничтожает evidence. Неизвестный start time или повреждённая схема дают quarantine без вымышленной даты карты.
2. `/heroes` и `/leagues` сохраняются как immutable reference snapshots. В canonical таблицы попадают настоящие названия из справочника/ответа. Network I/O завершается до canonical транзакции.
3. `is_pro=true` требует единственного совпадения league ID с tier `professional`/`premium`; `amateur`/`excluded` дают false, остальные случаи — null. `/proMatches` остаётся discovery. Это ретроспективная классификация, не доказательство доступности tier до старта.
4. Карта защищена advisory transaction lock. Проверяются слоты 0..4/128..132, distinct герои, account IDs и существующие **verified** `player_external_accounts`. Никнейм не объединяет игроков, provisional link не допускается. Без verified link canonical player остаётся null, source account хранится отдельно.
5. Итог требует bool winner, положительной duration и окончания не позднее `fetched_at`; winner без подтверждения завершения не становится меткой. Post-start stats сохраняются как факты результата, не предматчевые признаки.
6. `event_at`, `known_at`, `fetched_at` различаются. У исторических фактов `known_at=null`; фактические участники завершённой карты не превращаются в известный заранее ростер. Patch остаётся null до S0-06. Series связывается только с существующей подходящей reference; BO3/номер карты не угадываются.

Полный HTTP body, chat и profile data не записываются в БД/лог. Receipt содержит минимальную проекцию для повторной нормализации; его SHA относится к исходному body, а не к JSON-проекции. Это граница хранения, не полный byte-for-byte архив ответа.

## Quality facets и raw draft

Raw `picks_bans`, сыгранные герои и verified timeline независимы. Raw сохраняет порядок, дополнительные JSON-поля и все 0/11/12 picks; null отличается от `[]`. Outliers не обрезаются. Отсутствие организации/серии не удаляет валидные final heroes.

Assessment содержит outcome/player/final-hero/organization/series/draft статусы, anomaly codes и policy/context hash. Даже 10 совпавших picks подтверждают только структурную согласованность: `draft_order_valid=null` до исторических правил режима/патча. `match_draft_actions` не наполняется недоказанными событиями. Lane hints не назначают Pos 1–5. `n_raw=1` означает одну карту, десять слотов не увеличивают выборку.

## Идемпотентность и исправления

Receipt дедуплицируется по provider/map/payload/adapter/normalizer/context; reference snapshots и quality policy входят в context. Sources, field observations, assessments и raw observations append-only. Canonical fingerprint сравнивает материализованные факты карты/игроков; bigint IDs приведены к строкам. Идентичный импорт не увеличивает `data_revision`.

Nullable факты можно дополнить. Изменение известного результата, времени, команды/лиги/серии, pro classification, героя, account/canonical identity или записанных stats даёт conflict: прежние значения сохранены, новый source архивирован, `ingest_state=conflict`, `is_pro=null`. Replay старого ответа не снимает conflict. Автоматического разрешения нет; frozen predictions/datasets не переписываются.

`accepted` означает завершённую pro-карту с валидными final heroes для дальнейшего рассмотрения. Это **не** разрешение на training/prediction: canonical IDs, point-in-time evidence, patch metadata и stage-specific gates проверяются отдельно.

## Очередь и лимиты

- `opendota-map-import`, singleton key = match ID, policy exclusive; at-least-once, SQL idempotency. Transient ошибки: до трёх retries/backoff; timeout/heartbeat. Permanent source ошибки получают failed/dead-letter запись `opendota-map-import-failed`.
- Shared PostgreSQL row сериализует worker/spike/live audit requests. Defaults: 45 RPM, 2000/day, 45000/month; UTC boundaries, state переживает рестарт. Credits не возвращаются при HTTP failure. Upstream headers могут дополнительно блокировать отправку. Каждый job получает отдельный bounded client; quota общая.
- Длинный Retry-After: completion старого attempt и future job создаются одной Kysely транзакцией через поддерживаемый pg-boss DB adapter. Новый UUID записан в output старого job как `nextJobId`; send failure откатывает completion. До трёх deferrals, затем bounded failure/manual re-enqueue.
- Job принимает match ID и внутренний bounded deferral counter; caller не задаёт winner/is_pro/label. Нет HTTP endpoint импорта, scheduler, training или activation.

## Запуск

После `.env`, frozen install и `pnpm db:migrate`:

```bash
pnpm worker:dev
# другой терминал:
pnpm ingest:enqueue --match-id 9069021061
# либо одноразово, ожидание до 180 секунд:
pnpm ingest:once --match-id 9069021061
# статус job (корневая .env):
pnpm --filter @dota/worker exec tsx --env-file-if-exists=../../.env src/cli.ts status --job-id JOB_UUID
```

`once` может вернуть completed/deferred + `nextJobId`: это не accepted map; future job требует продолжающего работать worker. После исчерпания retry/deferral budget владелец проверяет причину и повторяет enqueue. CLI доступен обладателю DB credentials; до S0-03 приватного продуктового HTTP API нет.

Root-команды явно собирают shared packages; production использует `dist/*.js`. После shared source изменений перезапустить worker. Compose/Dockerfiles дополнены worker/workspace builds, контейнерное исполнение **не проверено**: Docker отсутствует.

## Проверки и live evidence

PASS:

- Frozen install, `pnpm typecheck`, `pnpm test` (64 unit), `pnpm build`.
- `pnpm test:ingestion` (16): repeat/concurrent import, raw 0/10 wrong-side/11/12 picks, missing identities, verified BIGINT identity > JS safe integer, correction/replay, rollback, immutability, quota concurrency/reset/restart, queue/retry, atomic Retry-After/rollback.
- `pnpm test:integration` (4 baseline DB); `node --test tests/node/*.test.mjs` (10 fixtures/regressions).
- Migration verifier (7 files, historical checksums), 007 APPLIED + repeat 7 SKIP, health smoke, actual OpenDota queue import/repeat. Docs links checked after handoff update.

Integration создаёт отдельные случайные `codex_ingest_*` databases, мигрирует и удаляет **только эти тестовые БД** после закрытия connections. Нужны права CREATEDB. Синтетика не попадает в рабочую БД или production training.

[Live evidence](evidence/s0-02-live-import.json): map `9069021061`, league `20395`, first job `62a8ef72-b3c1-4b37-b00b-cbdb11cf3b62`, repeat `440322e8-f879-4dbc-b81f-28fbdc87c018`. Оба accepted; repeat `duplicate:true`, `dataRevision:"1"`. БД: **одна карта, 10 слотов, один source snapshot и raw observation**, zero verified draft actions. Canonical IDs 0/10, patch, pre-start roster availability и series reference не подтверждены; active models 0. Это одно live end-to-end evidence, не corpus audit/backtest или проверка точности.

Исправлены воспроизведённые проверки: timestamp infinity при первом quota claim; root helper resolution shared package; bool winner без завершения; durable link deferred job. Windows sandbox запретил child process fixture runner; после разрешённого запуска все 10 PASS. UI/Python/E2E не менялись и не повторялись. Docker/remote CI не запускались, push/deploy не выполнялись.

## Следующая задача

**S0-03 [P0] Личный доступ:** CLI владельца, Argon2id, DB opaque session, cookie/CSRF/rate limit, tests 401/403/expiry. Рекомендация: **GPT-6.1 Sol · High** по [routing guide](CODEX_MODEL_ROUTING.md). Модель/High подтверждены в [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6.1-sol); рекомендация не переключает модель автоматически.
