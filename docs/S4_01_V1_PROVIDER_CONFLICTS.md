# S4-01/V1 — review конфликтов провайдеров

Checkpoint 2026-11-03. Проверяется текущий localhost V1: сохранение источников, отказ от автоматического выбора противоречащих фактов и безопасное чтение API. Новые источники и массовый live импорт не добавляются. Все новые HTTP ответы синтетические; отдельная тестовая PostgreSQL БД удаляется после проверки.

## Результат нового среза

Добавлен `apps/api/tests/provider-conflicts.integration.test.ts`: 8 проверок полного пути через текущий OpenDota client с injected fetch, importer, PostgreSQL repository и защищённые HTTP handlers. Production-код не менялся: новые cases сразу прошли. Они включены в существующий `pnpm test:pro-maps`, который уже вызывается CI; зависимости и workflow не менялись. Предположение о сохранении ошибочной принадлежности старой карты при новом identity conflict не подтвердилось.

| Ситуация | Проверенное поведение |
| --- | --- |
| Противоречащие winner, duration, финальный hero, account, series ID, organization ID | Прежние canonical факты и все match_players сохранены; источник получает conflict receipt/reasons; карта исключена из API статистики, N=0 и winRate=null. Оба source snapshots остаются. Точный повтор и возврат старого ответа не снимают conflict и не множат observations |
| Два провайдера связали один numeric account с разными игроками | resolveIdentity возвращает conflict/null; API исключает карту из личной статистики обоих игроков ещё до reimport и после него. Старый match_players.player_id сохраняется как прежний факт; reader заново разрешает identity и не доверяет этому cache. Никнейм не используется для объединения |
| Draft events противоречат финальным героям | Оба raw draft observations сохранены отдельно; actual ten heroes не переписаны, verified draft actions не созданы. Описательный результат карты остаётся доступным, но не считается проверенным драфтом или допуском модели |

Карантин importer очищает `matches.is_pro`. Legacy coverage counters взаимоисключающие и сначала проверяют pro status: такая карта попадает в unknownPro, а не повторно в conflict. Новый тест фиксирует это фактическое поведение. Conflict не потерян: ingest_state, immutable receipt/reasons и quality assessment его сохраняют; API показывает исключение и NO_ELIGIBLE_PRO_MAPS. Поле coverage.conflict нельзя трактовать как число всех архивных конфликтующих observations. В этом срезе policy и frozen readers не менялись.

## Связанные существующие проверки

Дополнительно выполняются suites identity, series provisioning, pro-map API, ingestion, V1 forecast/outcome и schedule-result binding. Они проверяют временные границы evidence, запрет автоматического объединения, BO2/BO3 и league/series ambiguity, CAS после изменившегося preview, raw evidence/transaction rollback, verified map-only outcomes, повторную привязку и сохранность первоначальных forecast/report snapshots.

Новые fixtures не становятся production history, ground truth или обучающей выборкой. `accepted` importer относится к map outcome/final heroes; это не подтверждение всех identity/series/draft полей и не разрешение вероятности.

## QA и сохранность

Frozen offline install/typecheck/build,727 unit/CLI,64 serial Node и79 selected PG cases — PASS. PG79 =8 новых import→API +16 series +15 forecast/outcome +7 schedule-result +7 pro-map API +14 import +12 identity. Общие unit/CLI и Node прошли одним запуском с прежними timeout, без повторов. Browser/Python/Docker/VPS/remote CI не запускались; UI/ML/runtime код не менялся. Новые8 cases подключены к существующей CI-команде test:pro-maps; remote CI исполнение этим не заявляется.

Read-only сверка78 relation entries(public65+pgboss13) до/после совпала целиком, включая auth/queue/jobs. Aurora/team321 осталась queued/created, attempt/processed/accepted/retry0, started_on null.37 protected artifacts,34 SQL ledger SHA, старый report/inference closure/frozen bundle unchanged, compatibleRuntime:true. Working scenarios/predictions/snapshots/active/release/E1/activations0, artifacts1/reports1. Provider/training/real evaluation/activation0. Рабочий worker не запускался. Evidence: `docs/evidence/s4-01-v1-provider-conflicts.json`.

Совместно с прежними security/queue/resilience checkpoints закрыт **S4-01 для текущего localhost V1**. Это не выпуск модели и не проверка VPS/HTTPS/Docker или более широкого двухмодельного MVP.

Фактически выполненные PG команды (после shared build):

```powershell
node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run apps/api/tests/provider-conflicts.integration.test.ts --testTimeout=30000 --maxWorkers=1 --no-file-parallelism
node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run packages/db/tests/identity.integration.test.ts packages/db/tests/series-provision.integration.test.ts apps/api/tests/pro-maps.integration.test.ts packages/ingestion/tests/import.integration.test.ts packages/db/tests/v1-forecast.integration.test.ts packages/db/tests/v1-schedule-result.integration.test.ts --testTimeout=30000 --maxWorkers=1 --no-file-parallelism
```

Общие проверки через локальный pnpm10.19.0: `install --frozen-lockfile --offline`, `typecheck`, `build`, `--workspace-concurrency=1 -r --if-present test --maxWorkers=1 --no-file-parallelism`; Node — `node --test --test-concurrency=1 tests/node/*.test.mjs`. PG тесты выполнены в отдельных временных БД; новые8 cases делят одну БД. Remote CI не запускался.

## Границы

Это проверка реализации на известных видах противоречий, не доказательство live полноты или безошибочности источников. Review UI для ручного исправления идентичностей, более подробная классификация exclusion reasons и новые provider adapters остаются в своих заявленных этапах. Не менялись исторические model evaluations, исходный executor или compatibility policy.

**Следующий точный срез — S4-02/V1-historical-regression:** сверить текущий V1 с frozen data и существующими temporal/series/identity regression gates, без ранней оценки будущего окна, изменения frozen policy или активации модели. Рекомендуемая модель: **GPT-6.1 Sol · High**.
