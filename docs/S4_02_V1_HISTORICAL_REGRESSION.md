# S4-02/V1 — историческая регрессия признаков

Checkpoint 2026-11-03. Добавлена offline-команда `pnpm regression:v1`: воспроизводит замороженный development dataset и сравнивает текущие признаки с SHA-bound прежним экспортом. Она не читает рабочую БД, не обращается к провайдерам, не исполняет код из контрольного JSON, не считает метрики точности и не активирует модель.

## Команда и проверяемые границы

```powershell
pnpm regression:v1 verify dataset.json DATASET_SHA256 reference-features.json REFERENCE_SHA256 new-report.json
```

Оба входа ограничены64 MiB, SHA проверяется до JSON parsing. Dataset заново проходит существующий `verifyV1Data`, eligibility/outcome/whole-series boundary. Контрольный экспорт обязан ссылаться на тот же source SHA. Все feature rows, assumptions, policy, sample coverage и временные поля должны совпасть; исключены из сравнения только архивный code manifest и его внешняя source-file привязка, которая проверяется отдельно. Старый manifest не заменяется текущим и никогда не исполняется.

Каждая строка дополнительно воспроизводится через общий runtime entry point `buildV1Features`; все usedMatchIds проверяются на `started_at < cutoff` и `completed_at < cutoff`, без самой целевой карты. Отчёт содержит текущие tool/core SHA и Node runtime provenance, summary, semantic feature SHA, число сверенных строк/связей. Он всегда имеет `evaluation:not_performed`, `deployable:false`, `teamAWinProbability:null`. Даже passed означает только regression, не model quality gate.

Выход создаётся эксклюзивно после проверок: существующий файл не перезаписывается, failed validation не оставляет готовый отчёт. Ошибки имеют безопасные коды и русское сообщение, без raw payload/URL/secret. Synthetic provenance сохраняется; тестовый набор не выдаётся за live pro coverage.

## Выполненная сверка реального development snapshot

```powershell
node scripts/check-v1-historical-regression.mjs verify .tools/v1-data-export.json 79ae50020134a30ad822d9780934518e64010fb85fc367885d3e12092c70eed5 .tools/v1-features-development-final.json bb33ee716beb88c277bcc6632203c29e841db0f13e03b822f1541bb54b40c658 .tools/s4-historical-real-report.json
```

Результат PASS:232 карты,152 featureReady и80 unavailable, все232 строки совпали с прежними признаками и shared runtime. Проверены26637 ссылок на прошлые завершённые карты: это повторное использование истории в разных целевых строках, **не26637 независимых карт**. Semantic feature SHA `629986e95366ae61b55e034d9c1c824b58dc9b70eb931cf50f926234a5c253d3`; новый report SHA `c254512e81f417e87cb1c3118d2238a2b37d8bbd9912e1cebefc8b7d78220541`.

Эти232 карты остаются прежней development выборкой, не новым Tier1 holdout, не prospective accuracy и не полным текущим/удалённым корпусом. Старые bytes источника, экспорта, E0/E1, release plan и executor сохранены. Полный старый feature artifact с его историческим code manifest не переписывается; сравнивается содержимое признаков, а текущий manifest записан в новом отчёте.

Сохраняется conditional reconstructed-lineup basis и прежняя event-time availability assumption. Проверка времени завершения не доказывает историческую доступность состава или источника: реальные known_at/fetched_at и assumptions не переписываются.

## QA и сохранность

Frozen offline install/typecheck/build,730 unit/CLI,64 serial Node и50 selected PG — PASS. Новые3 cases входят в334 db unit tests и общий730; ранний targeted3 не добавляется повторно к total. PG50 =7 dataset-series +9 V1 runtime +7 registry +7 V1 data +8 outcome +12 identity. Общие unit/CLI и Node прошли одним запуском с прежними limits, без повторов. Browser/Python/Docker/VPS/remote CI не запускались; полный browser suite — следующий срез.

Read-only сверка78 relation entries(public65+pgboss13) совпала целиком, включая auth/queue/jobs. Aurora/team321 остаётся queued/created с attempt/processed/accepted/retry0 и started_on null; worker не запускался.38 protected artifacts,34 SQL ledger SHA, старый report, весь existing inference/history/runtime и frozen bundle unchanged, compatibleRuntime:true. Working active/scenarios/predictions/snapshots/release/E1/activations0, artifacts1/reports1. Provider/training/real model evaluation/activation0. PROGRESS только append. Evidence: `docs/evidence/s4-02-v1-historical-regression.json`.

S4-02 остаётся unchecked: этот срез закрывает historical feature regression, не full E2E или независимую модель/release gate.

Новые файлы: `scripts/check-v1-historical-regression.mjs`, `scripts/lib/v1-historical-regression.mjs`, `packages/db/tests/v1-historical-regression.test.mjs`; `package.json` добавляет только regression:v1. Existing inference/history/contracts/quality thresholds/SQL migrations не меняются.

**Следующий точный срез — S4-02/V1-full-owner-e2e:** полный существующий browser suite текущего localhost V1 на изолированных данных, owner flow и loading/error/unavailable states; без новой оценки будущего окна/активации модели. Рекомендуемая модель: **GPT-6.1 Sol · High**.
