# S3-07/V1-scheduled-owner-flow — расчёт со страницы встречи

**Продолжение2026-11-03:** [owner API/UI сопоставления и verified refresh реализованы](S3_07_V1_SCHEDULED_BINDING_OWNER_FLOW.md). Следующий срез — S3-07/V1-scheduled-target-lifecycle.

На странице сохранённого назначения `/schedule-targets/:requestId` владелец выбирает сохранённый ручной сценарий5v5, проверяет совпадение контекста и запускает расчёт. Результат сохраняется как `real_map` с исходной редакцией назначения и состава; доступен по постоянной ссылке `?forecast=UUID`. История этой редакции назначения показывает успешные и недоступные попытки. Это часть S3-07, не завершение V1 release или проверки качества модели.

## Действия владельца

1. Открыть сохранённое назначение из расписания. Выбрать сценарий из списка по20 записей либо перейти по ссылке подготовки нового.
2. В новом сценарии команды A/B, локальный турнир, плановое время и карта1 подставляются из назначения. Десять игроков остаются пустыми: владелец выбирает их вручную, подтверждает и сохраняет сценарий. Правки уже заполненной формы не перезаписываются запоздавшим ответом назначения.
3. Вернуться к назначению и проверить сохранённые5v5. Команды A/B, турнир, время и map1/null series должны точно совпадать. При несовпадении кнопка расчёта недоступна; сервер независимо повторяет эти проверки.
4. При наличии проверенного Tier1 event scope заполнить его: ID лиги **OpenDota**, название, границы UTC, источник и объяснение. Этот ID не заменяется PandaScore tournament ID. Без scope или активной модели попытка сохраняется как unavailable/null с причинами.
5. Нажать «Рассчитать назначенную карту». Сохранённый результат показывает исходные5v5, редакцию, срез/время, покрытие/N, модель, причины недоступности либо gated probability. Участие выбранных игроков остаётся ожидаемым.

Потерянный POST-ответ безопасно восстанавливается GET по UUID из адреса либо повтором **того же** UUID/тела. На время неизвестного результата форма фиксируется; новый состав требует нового запроса. Старые результаты остаются читаемыми после изменения состава, расписания, начала встречи или новой редакции назначения. После конфликта владелец обновляет сведения и принимает новый выбор явно.

## HTTP

Все маршруты требуют owner/session, ответы `no-store`; POST дополнительно требует Origin/CSRF. Новых SQL-миграций нет, используются существующие snapshots и nullable schedule-target FK.

| Метод | Маршрут | Результат |
|---|---|---|
| POST | `/api/v1/schedule-targets/:targetId/forecasts` | Сохранить попытку либо восстановить exact retry |
| GET | `/api/v1/schedule-targets/:targetId/forecasts?offset=0` | История этой редакции,20 items + hasMore |
| GET | `/api/v1/schedule-targets/:targetId/forecasts/:requestId` | Неизменяемая ограниченная проекция |

POST body: `requestId`, `scenarioId`, `expectedRevision`, `targetSha256`, `targetScope`. Владелец берётся из сессии. Сервер строит PandaScore selector из сохранённого назначения; `purpose`, model/output/clock/provider IDs во входе запрещены. Body и params проходят Zod, подмена SHA/редакции/источника/контекста отклоняется. Ошибки не возвращают provider payloads, account links, artifact bytes или code manifests.

`V1ScheduledPredictionViewSchema` содержит `purpose:real_map`, versioned target reference и прежние bounded поля расчёта. What-if contract и его маршруты сохраняют отдельный purpose. История/чтение проверяют владельца и target revision, посторонний requestId не раскрывается.

Общий `V1PredictionService` ограничивает одновременно исполняемый расчёт для обоих HTTP потоков, до занятия history connections. POST6/min, занятый расчёт →429/Retry-After. Startup fingerprint, текущие source/scenario/model/release locks, Tier1/coverage gates и SQL033 запрет выдачи после известного результата повторно используются из runtime. HTTP слой не обучает и не активирует модель.

## Следующий шаг

**S3-07/V1-scheduled-binding-owner-flow:** owner API/UI ручного сопоставления с проверенной OpenDota картой и verified refresh на основе существующего CLI/service; затем lifecycle назначений расписания. Исходные прогнозы, связи и отчёты остаются неизменяемыми. Весь S3-07/V1 release открыт. Рекомендуемая модель: **GPT-6.1 Sol · High**; при изменении правил идентичности/фактического времени — GPT-6 Astra · High.

## Проверено2026-11-03

**QA завершена:** offline frozen install, полный typecheck/build и финальные web typecheck/build PASS. **707 уникальных unit/CLI,104 isolated PostgreSQL,28 browser E2E** PASS; новых5/7/4 соответственно. Первоначальные4 browser cases не находили exact label селектора: отдельная диагностика подтвердила HTTP200 и существующий select, обёрнутая подпись включала option text. Исправлена доступность через label for/id; повтор4cases и итоговые28 PASS без изменения timeout/auth. Desktop/360px просмотрены, переполнения страницы нет.33 migration checksums/docs links/diff проверены. Evidence: `docs/evidence/s3-07-v1-scheduled-owner-flow.json`.

**Сохранность:** новых миграций нет; SQL001–033 и25 protected artifacts unchanged.21 working-table fingerprints, E0 exact replay,232 feature rows, archived executable/current kernel compatibility PASS. Старый report revision1/SHA bd42a60064c42daa4281bcb0e8972eba79d72737a4fccffe480d8a8725767398 читается с N0/legacy cancelled null. Рабочие models1/artifacts1/active0/activations0/E1/release0/scenarios0/predictions0/snapshots0/outcomes0/refresh0/reports1/lifecycle0/scheduleTargets0/scheduleResultBindings0. Dota provider calls/imports/training/реальных оценок/активаций0. Synthetic fixtures только для контрактов/display и изолированных тестовых баз.
