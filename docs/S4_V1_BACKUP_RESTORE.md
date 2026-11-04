# S4/V1 — native PostgreSQL backup/restore drill

**S4-SEC-03 закрыт для текущей процедуры:** [queue coverage](S4_01_V1_QUEUE_COVERAGE.md) заменил фильтр схем на `!~ '^pg_'` и реально проверил78 relation entries(public65+pgboss13), queued payload/run link и обнаружение подмены в copy. Старый65-entry evidence ниже сохранён как историческая public-only проверка; dump и прежде не имел schema exclusions. Ни новые результаты, ни старый PASS не заменяют independent model gate, active-model restore или Docker/VPS release validation.

Дата: 2026-11-03. Область — проверка восстановления текущей localhost-first версии, её immutable snapshots и сессий. Это локальная процедура с PostgreSQL16; Docker/VPS и offsite retention в ней не участвуют.

## Запуск на этой Windows-машине

Из `dotaanalitic`, с настроенным `DATABASE_URL` в `.env`, нативным PostgreSQL16 и ролью с CREATEDB:

```powershell
pnpm backup:verify --pg-bin .tools/pgsql/bin --bundle .tools/v1-frozen-runtime
```

Команда сначала собирает shared packages. Нужны `pg_dump` и `pg_restore` версии16 из указанного каталога. Для нескольких зарегистрированных frozen artifacts повторите `--bundle путь`. Если в БД нет V1 artifacts, bundles необязательны. Пароль подключения передаётся дочерним PostgreSQL-утилитам через окружение, не аргументом командной строки и не через stdout. CLI выводит статус, относительный путь каталога и безопасную сводку.

Команда принимает только `--pg-bin` и `--bundle`; исходная БД берётся из локального PostgreSQL URL без query overrides. Удалённые хосты, имя существующей цели и внешний архив не принимаются. Поэтому этой командой нельзя случайно перезаписать рабочую БД или выполнить чужой dump.

Дочерние PostgreSQL-утилиты получают очищенное от унаследованных `PG*` переменных окружение и явные host/port/user/database/password. В частности, `PGHOSTADDR`, `PGSERVICE` и `PGOPTIONS` не могут подменить выбранное подключение. Их влияние описано в [libpq environment variables](https://www.postgresql.org/docs/16/libpq-envars.html); отдельный regression test сначала воспроизвёл отказ с невалидным унаследованным hostaddr, затем прошёл после очистки.

## Что проверяется

1. Для источника открывается repeatable-read/read-only транзакция, устанавливается UTC и экспортируется snapshot. Все прикладные таблицы, включая очередь при её наличии, получают count и fingerprint строк. `pg_dump --format=custom --snapshot=... --no-owner --no-acl` читает тот же snapshot. Согласованный snapshot и custom format описаны в [PostgreSQL16 pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html).
2. Архив `database.dump` получает SHA-256. Файлы frozen executable/model bundles копируются отдельно, сверяются по SHA и повторно проверяются штатным `readV1RegistryBundle`. Каждый `v1_model_artifacts.freeze_sha256` должен иметь соответствующий bundle. JS из копируемого bundle не исполняется.
3. Создаётся новая база `codex_restore_<12 hex>`. В неё выполняется `pg_restore --exit-on-error --single-transaction --no-owner --no-acl`. Опции `--clean` и `--create` не используются: целевое имя не может быть заменено именем из архива. Семантика этих опций — в [PostgreSQL16 pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html).
4. Все таблицы сравниваются с исходным snapshot до каких-либо изменений. Сохранённые forecasts и journal reports читаются через репозитории приложения: SHA, схема и детерминированный replay должны пройти.
5. Только в восстановленной базе все строки `auth_sessions` без `revoked_at` отзываются. Наличие неотозванных строк после операции считается ошибкой. Это обязательная процедура до открытия восстановленного приложения: копия токена из backup не должна восстанавливать доступ. Исходные сессии не отзываются.
6. После проверки все таблицы, кроме намеренно изменённой `auth_sessions`, повторно сверяются. Затем закрываются подключения и удаляется только созданная база. Cleanup проверяет сгенерированное имя, отличие от источника и PostgreSQL OID. Он выполняется и при ошибке проверки.

## Файлы результата

Каждый запуск создаёт новый каталог `.tools/backups/restore-<random>` без перезаписи предыдущих копий:

- `database.dump` — полный custom archive одной БД;
- `backup.json` — SHA архива, fingerprints таблиц и список файлов bundles;
- `bundle-N/` — замороженный код/конфигурация/данные для зарегистрированного V1 artifact;
- `drill.json` — только при успешной проверке, с числом таблиц, forecasts/reports, отозванных сессий и подтверждением удаления цели;
- `failure.json` — при ошибке после подготовки каталога: безопасный code, наличие копии и состояние cleanup. Если проверка OID не прошла, база автоматически не удаляется; её сгенерированное имя сохраняется для разбора.

Архив содержит приватные данные владельца, включая password hashes и сохранённые токены в хэшированном виде. Он хранится в игнорируемой `.tools` и не коммитится; на POSIX каталог имеет0700, файлы0600. На Windows действуют ACL родительского каталога. Локальный архив не зашифрован и не отправляется за пределы компьютера. Для постоянного хранения нужна отдельная зашифрованная offsite копия с политикой retention владельца.

Это single-database backup: cluster roles/tablespaces, `.env` и пароли, установленный Node/PostgreSQL и `node_modules` не входят в архив. Для чтения модели требуется совместимый Node binary/runtime, замороженный lockfile и зависимости; приложение восстанавливается из соответствующего checkout. Проверка fingerprints относится к таблицам; PostgreSQL sequence state переносится штатным dump/restore и отдельно этой сводкой не измеряется.

## Проверки и ограничения

`apps/api/tests/local-restore.integration.test.ts` использует отдельную synthetic source DB с forecast, journal, lifecycle и действующей сессией. Проверяются настоящий dump/restore, неизменяемые bytes/SHA,34 idempotent migrations, восстановленные immutable triggers, отказ прежнего токена в копии и сохранение доступа в source. Второй случай намеренно проваливает финальную проверку и проверяет cleanup и сохранность источника. Третий регистрирует только synthetic inactive artifact и подтверждает отказ без нужного bundle до создания restore target. Unit cases запрещают небезопасные цели/URL/flags и проверяют отсутствие секретов в CLI errors.

Реальная рабочая модель сейчас inactive; проверка копирует её исходное состояние и bundle, не выполняет activation/rollback или оценку качества. Restore с активной реальной моделью требует повторного drill после её отдельной разрешённой активации. Docker/VPS/HTTPS и offsite backup этим результатом не подтверждаются.

Для аварийного восстановления сохранённого архива применяется стандартный `pg_restore` в **новую изолированную базу**, с последующей сверкой SHA, файлов модели и обязательным отзывом сессий до запуска API/worker. `backup:verify` — воспроизводимый drill свежей копии, а не команда переключения рабочего сервиса на восстановленную базу. Действующий Docker runbook сохранён отдельно в [OPERATIONS_RUNBOOK](OPERATIONS_RUNBOOK.md).

Следующий точный срез — **S4/V1-local-owner-smoke**: локальный запуск и проверка основных экранов на рабочих данных, с явными причинами unavailable и сохранением model quality gate. Независимый Tier1 release test остаётся открытым по прежнему плану.

## Исполнено

**QA:** frozen offline install, typecheck/build PASS;721 уникальный unit/CLI,64 Node fixture и4 PostgreSQL integration PASS. Targeted initial5 PASS. Ранняя проверка и окончательная штатная команда backup:verify прошли на реальных рабочих данных:65 tables /16447 rows, archived forecasts0/reports1, sessionsRevoked1 только в копии, bundlesVerified1; targetDropped=true. Это не новая real-map evaluation или вероятность. Новый env regression сначала воспроизвёл POSTGRES_COMMAND_FAILED с невалидным унаследованным PGHOSTADDR, после исправления прошёл.

**Учет сбоев/повторов:** первый общий unit run прошёл54/17/13/33/331/228, затем API42/43 и один timeout в новом CLI case (reported564733ms при child timeout20s, status null) плюс Vitest RPC onTaskUpdate timeout; причина задержки не установлена. После env hardening добавлен один unit case; весь API44 и worker1 повторены без увеличения исходных лимитов, чисто PASS.721=676 неизменённых cases+44 окончательных API+1 worker, не сумма повторов. Старый лог и намеренный red env test сохранены. Browser/HTTPS/Docker/remote CI/Python в этом срезе не запускались.

**Сохранность:** независимая read-only сверка65 исходных таблиц, включая auth_sessions, совпала с dump snapshot;21 прежний working fingerprint и29 protected artifacts unchanged. Все34 ledger SQL SHA совпали с файлами, runtime compatible, source model inactive/active0, E1/release/activations/predictions/scenarios0; прежний report revision1/N0/SHA сохранён. Bundle copied238 files и повторно verified; dump/model files только в игнорируемой .tools/backups, без .env/установленных зависимостей и без offsite передачи. Рабочие сессии не отозваны. Real provider HTTP/import/training/activation0.

Evidence: `docs/evidence/s4-v1-backup-restore.json`.
