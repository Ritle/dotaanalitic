# S4-01/V1 — pg-boss в backup/restore verification

Дата:2026-11-03. Finding S4-SEC-03: SQL `nspname NOT LIKE 'pg_%'` исключал также application schema `pgboss`, поскольку `_` в LIKE — wildcard. Dump был полным, но comparison пропускал очередь. В `scripts/lib/local-restore-drill.mjs` фильтр заменён на `nspname !~ '^pg_'`: исключаются только системный prefix `pg_` и `information_schema`, а pg-boss и другие user schemas с pg-prefix включаются.

Остальная процедура прежняя: exported read-only snapshot источника, новый custom dump, только новая target DB с prefix/OID guard, сравнение до чтения snapshots, отзыв сессий только в копии, повторная сверка после inspection и cleanup. Новых migrations/dependencies/API/model gates нет. Очередь в восстановленной копии проверяется SQL; worker не запускается, provider requests не требуются.

## Regression

Новый `apps/api/tests/local-restore-queue.integration.test.ts` создаёт настоящий pg-boss и queued history refresh в отдельной временной БД через штатные queue helpers, затем останавливает boss. Worker/provider не создаются. Дополнительная user schema `pgapplication` проверяет отличие SQL wildcard от literal prefix; BIGINT probe сохраняется строкой.

1. Проверяются manifest entries `pgboss.job`, partition `job_common`, custom schema, payload/run link/state/attempt и неизменность источника после restore.
2. В новой восстановленной копии меняется только payload при прежнем числе строк. Проверка должна вернуть `RESTORED_DATA_CHANGED` и удалить только свою target DB; исходная очередь неизменна.

До исправления2 FAIL: queue отсутствовала в manifest, подмена принималась как verified. После однострочного исправления2 PASS. Parent/partition entries могут содержать те же строки; `tables`/сумма relation row counts в отчёте — метаданные инвентаризации, не число независимых jobs, pro-карт или training examples.

## Следующий срез

**S4-01/V1-provider-resilience-review:** существующие OpenDota/PandaScore clients, timeout/429/Retry-After/5xx/quota/idempotency и честные stale/partial ответы. Исправлять только воспроизведённые нарушения, без массового live fetch, изменения frozen policy или model activation. Общий S4-01/S4, независимый model/release и active-model restore остаются открытыми. Рекомендуемая модель: **GPT-6.1 Sol · High**.

## Исполненная проверка

Frozen offline install, typecheck/build,727 unit/CLI и64 Node PASS без повторов. Node64 выполнены с `--test-concurrency=1` с самого начала из-за прошлых параллельных spawnSync timeouts; case/child limits прежние. Selected PG6 PASS:3 существующих snapshot/cleanup/model-bundle cases,1 libpq env regression и2 новых queue cases. Targeted2 PASS после red2; в число уникальных PG случаев повторы не добавлены. Browser/Python/Docker/VPS/HTTPS/remote CI не запускались: UI/API/domain code не менялся, native PG/CLI исполнялся реально.

Штатный CLI после сборки shared packages: `node --env-file-if-exists=.env scripts/local-restore-drill.mjs --pg-bin .tools/pgsql/bin --bundle .tools/v1-frozen-runtime`. Рабочий источник восстановлен в новую изолированную БД:78 relation entries(public65+pgboss13), report1/forecasts0, bundle1 verified. Manifest/archive/drill SHA проверены, копированные2 активные сессии отозваны только в target, targetDropped:true. Worker в target не запускался. Каталог `.tools/backups/restore-e457f49e44db3a2117847044` содержит private dump/bundle и остаётся ignored/local, offsite передачи не было.

Независимая read-only before/after сверка всех78 entries совпала, включая jobs/configuration/operational rows; public данные и рабочие сессии не изменились. Aurora Gaming/team321 остаётся queued/created, attempt/processed/accepted/retry0, started_on null. Задание не отменялось и не выполнялось этим drill. Прежний report SHA,35 protected artifacts,34 SQL ledger SHA и вся compiled inference/history closure сохранены, compatibleRuntime:true; frozen bundle verified. Working active/scenarios/predictions/snapshots/release/E1/activations0, artifacts1/reports1. Provider/training/real evaluation/activation0.

Начальный helper сохранности не распознал единственную JSON строку CLI из-за UTF-16 BOM PowerShell. В reader добавлено удаление начального BOM, тот же successful CLI log проверен повторно; продуктовый код/drill не повторялись и не менялись. Это диагностический повтор, исходный лог сохранён.

**S4-SEC-03 закрыт для текущего native verifier**: полнота очереди и обнаружение её изменения подтверждены. Старые snapshots/evidence не переписаны; прежний65-entry drill остаётся исторической public-only проверкой. Весь release/model/active-model restore gate этим не закрывается. Evidence: `docs/evidence/s4-01-v1-queue-coverage.json`.
