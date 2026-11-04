# S4-01/V1 — устойчивость OpenDota и PandaScore

Checkpoint 2026-11-03. Область: текущие HTTP clients, durable quota, расписание и фоновые повторы. Внешних HTTP-запросов в этой проверке нет; ответы источников синтетические, интеграционные тесты используют отдельные временные PostgreSQL БД. Это проверка поведения приложения при сбоях, не измерение live coverage или доступности провайдеров.

## Исправление

Обнаружен и воспроизведён S4-UPSTREAM-01: OpenDota client учитывал Retry-After для 429 и всех 5xx, а PostgresProviderBudget сохранял указанный срок только для 429/503. После 500/502/504 новый client с общей БД мог отправить запрос раньше срока. Регрессионные тесты до изменения: 3 failed (500/502/504), 2 passed (429/503).

В `packages/ingestion/src/quota.ts` изменено только условие durable cooldown: 429 или status >=500. Политика ожидания без заголовка, лимиты, число попыток и HTTP contracts сохранены. Новый client теперь получает source_rate_limited до HTTP и не расходует дополнительную квоту. Миграции и зависимости не требуются.

## Проверенная область

| Граница | Проверка |
| --- | --- |
| OpenDota HTTP | Существующие unit cases: timeout/abort, конечные повторы и учёт попыток, seconds/date Retry-After, 429/503, long cooldown следующего вызова, ошибки сети без raw secret, fixed host/redirect refusal, ограничение bytes/JSON/schema |
| OpenDota durable quota | Новые 5 PG cases: Retry-After после 429/500/502/503/504 сохраняется между клиентами; второй fetch не вызывается; счётчик остаётся 1. Существующие cases: атомарный permit, rollover и бюджеты |
| PandaScore HTTP | Существующие unit cases: timeout, 429/5xx и request budget, фиксированный host, token только в header, ограничение bytes/UTF-8/JSON/schema, quota denial до HTTP |
| PandaScore cache/quota/API | Новые 2 PG cases: после 429/503 с Retry-After=120 старый snapshot остаётся stale/source_unavailable, credential отсутствует, новый quota repository отклоняет запрос, повторный refresh и GET не вызывают provider, immutable observation остаётся 1. Существующие cases: cache lease/CAS, clock, hourly quota, reflected token, invalid cache |
| Импорт | Existing PG: exact/parallel retry сохраняет 1 map/10 slots, rollback не оставляет полукарту, неизвестный pro status исключается, конфликт account/winner не перезаписывает подтверждённые факты |
| Фоновая работа | Existing PG: partial сохраняет принятые карты и сообщает ошибки, durable retry сохраняет run/map identity, Restart/Retry-After deferral и rollback проверены в отдельной очереди |

## Выполненные проверки

Frozen offline install, typecheck, build, 727 unit/CLI, 64 serial Node cases и 44 selected PG cases — PASS. PG44 = 5 новых quota +14 import +13 upcoming +8 history +4 queue; новых cases7. Общие unit/CLI и Node выполнены одним финальным запуском, без изменения timeout. Первый sandbox install отменился с no-TTY: pnpm не увидел существующий store. С доступом к прежнему локальному store тот же frozen offline install прошёл Already up to date, без переустановки. Browser/Python/Docker/VPS/remote CI не запускались: UI/ML/deployment не менялись. Предупреждение Vite о размере существующего web chunk сохранено.

Read-only сверка всех 78 relation entries (public65+pgboss13) до/после совпала целиком, включая auth и очередь. Aurora/team321 осталась queued/created, attempt/processed/accepted/retry0, started_on null; worker не запускался. Сохранены36 protected artifacts,34 SQL ledger SHA, старый report, inference closure и frozen bundle; compatibleRuntime:true. Working scenarios/predictions/snapshots/active/release/E1/activations0, artifacts1/reports1. Provider/training/evaluation/activation0. PROGRESS обновлён только добавлением. Evidence: `docs/evidence/s4-01-v1-provider-resilience.json`.

Воспроизводимые команды PG (после shared build, DATABASE_URL только для локального тестового администратора; helper создаёт и удаляет свои временные БД):

```powershell
node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run packages/ingestion/tests/provider-resilience.integration.test.ts packages/ingestion/tests/import.integration.test.ts apps/api/tests/upcoming.integration.test.ts --testTimeout=30000 --maxWorkers=1 --no-file-parallelism
node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run apps/api/tests/history.integration.test.ts apps/worker/tests/queue.integration.test.ts --testTimeout=30000 --maxWorkers=1 --no-file-parallelism
```

## Границы и следующий шаг

Расписание остаётся ограниченной сохранённой страницей; отсутствие записи не доказывает отмену встречи. Live provider SLA, полное покрытие расписания, будущие реальные сбои и поведение третьих сторон этими тестами не доказаны. Синтетические fixtures не участвуют в production learning. Рабочий worker не запускался.

Следующий точный срез — **S4-01/V1-provider-conflict-review**: проверить текущие ветки конфликтов identity/map outcome/series/draft/provenance и безопасные API предупреждения; исправлять только воспроизведённые нарушения. Не добавлять новый источник или произвольное автоматическое объединение. Общие S4-01/S4 и независимые model/release gates пока открыты. Рекомендуемая модель: **GPT-6.1 Sol · High**.
