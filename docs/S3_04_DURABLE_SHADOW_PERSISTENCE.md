# S3-04 — автоматическое сохранение исследовательского расчёта драфта

14 ноября 2026. Срез `post-draft-validation-readiness/durable-shadow-persistence`.

## Что изменилось для владельца

При фиксации полного драфта сервер автоматически рассчитывает фиксированные H0/H1/H2 по сохранённым составам, пикам и истории. Отдельный запуск CLI больше не нужен. В Draft Lab появляется статус сохранения попытки и время подтверждения записи. Исследовательские числа остаются приватными: пользовательский прогноз после драфта пока не активирован.

Если сохранение прервалось, кнопка **«Завершить сохранение расчёта»** восстанавливает его. Уже записанные входы и результат не пересчитываются. При несохранённых изменениях кнопка отключена: сначала нужно сохранить редакцию. Открытие старого снимка само по себе не запускает расчёт. Для старой редакции без результата доступно явное завершение сохранения с текущим временем, без датирования задним числом.

Отсутствие модели или пригодной истории сохраняется как `unavailable`, а не как выдуманная вероятность. После обновления данных нужна новая редакция сценария; прежняя попытка остаётся неизменной.

## Данные и две транзакции

Миграция `061_owner_draft_shadow_results.sql` добавляет две append-only таблицы. SQL001–060 сохранены.

1. `owner_draft_shadow_runs`: один результат на capture ID, ссылки и SHA SQL058/060, точный текст кандидата с SHA, версия политики, digest исполняемого кода, входы, причины исключений и private scores либо unavailable. Сервер выставляет время записи и top-level transaction ID. Advisory lock и повторное чтение после lock обеспечивают идемпотентность конкурентных запросов.
2. После commit первой транзакции отдельная транзакция записывает `owner_draft_shadow_receipts`: SHA результата и время его наблюдения как уже committed. MVCC и отличающийся `txid_current()` исключают подтверждение в той же транзакции, включая savepoint. Crash между транзакциями восстанавливается без пересчёта результата.

Receipt доказывает, что результат был committed не позднее `observed_committed_at`. Это **не точное время commit**, не момент начала Dota-карты и не доказательство pre-gameplay пригодности. Commit самого receipt происходит позже его времени наблюдения. `calculatedAt` фиксирует начало вычисления; receipt следует после вычисления и commit результата. `primaryEligible`, `deployable`, `trainingPerformed` остаются false; `teamAWinProbability:null`.

UPDATE/DELETE/TRUNCATE обеих таблиц запрещены триггерами. История прогнозов, outcomes, registry и training dataset не меняются. Повтор использует старые байты даже после изменения окружения или отсутствия candidate-файла.

## Вычисления и совместимость

Новые API-модули `draft-shadow-{contract,runtime,repository,features,hero,inference}.ts` используют прежнюю проверенную математику. Дифференциальный тест сравнивает серверный feature builder с frozen offline adapter. Политика `selected-ten-and-known-series-exclusion-v1` исключает исторические встречи всех выбранных десяти аккаунтов и целиком их известные серии до чтения labels. Используются только допустимые более ранние verified pro maps; роли, никнеймы и неподтверждённые identity merges не подменяют аккаунты.

Кандидат загружается только из локального `.tools/s304-hero-fit-r1/artifact.json` с фиксированным SHA `9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b`; это исследовательский, недопущенный H2. Отсутствие файла даёт unavailable, synthetic fallback в production отсутствует. Файл не входит в исходники/деплой автоматически. Настройка другого хоста должна явно обеспечить этот артефакт, если нужен такой же private расчёт.

API использует существующий собранный `packages/prediction/dist` по явному относительному пути. Shared exports, package manifest и lockfile не изменялись: отдельная новая зависимость могла бы изменить environment hashes действующего V1. Как и прежде, перед запуском API нужна сборка монорепозитория. Перенос этой границы потребует отдельной проверки manifest/replay.

## HTTP и UI

Существующий owner-only `POST /api/v1/scenarios/:id/draft-captures` теперь завершает shadow persistence после фиксации capture; прежняя форма ответа не меняется. Потерянный ответ восстанавливается через чтение capture и идемпотентный retry.

- `GET /api/v1/scenarios/:id/draft-captures/:revision/shadow-summary` — только чтение статуса, без пересчёта.
- `POST /api/v1/scenarios/:id/draft-captures/:revision/shadow-retry` — строго пустой объект `{}`, прежние session/owner/CSRF проверки; завершает отсутствующую запись или возвращает прежнюю.

Ответы summary/retry содержат `captureId`, `status:missing|awaiting_receipt|computed_shadow_only|unavailable`, `recordedAt`, `observedCommittedAt`, `sha256`, `reasons`, `primaryEligible:false`, `teamAWinProbability:null`. Ни scores, ни candidate artifact, ни приватная история не выдаются. UI `DraftShadowSummary.vue` показывает краткое состояние, retry/error/dirty состояния; проверен на ширине360px. Provider HTTP не вызывается.

## Проверка и рабочая БД

Перед миграцией создан private custom-format pg_dump, проверен `pg_restore --list`; размер37449543 байта, SHA `05cde680dc9672117575e2780ed0ac9b4b9134f819d97e36b63b76c1098483ac`. Полный restore в этом срезе не выполнялся. Миграция061 применена, повтор вернул SKIP. API перезапущен с проверкой принадлежности процесса проекту.

На17:21:40UTC:2260 исторических карт,7 прежних prediction hashes и V1 `model_eligible` сохранены. API/Web200, private endpoint401. Реальных captures/history/shadow results/receipts пока0; положительные вычисления и отказоустойчивость проверены в изолированных тестах на синтетических входах. Это не live coverage и не новая оценка качества H2.

Проверены5 новых unit-тестов,23 PostgreSQL/API-теста (6 новых и17 прежних) и6 сценариев Chromium. Покрыты конкурентные запросы, crash между commit/receipt, запрет savepoint-обхода, immutable guards, owner/CSRF, потерянный POST-ответ и dirty/reload UI. Built API также проверен на262 frozen Python golden cases:1570 численных сравнений и2null, максимальная ошибка1,11e-16. Это проверка соответствия реализации, не новое обучение или качество прогноза. Итог общей регрессии и журналы перечислены в [evidence](evidence/s3-04-durable-shadow-persistence.json). Общие команды:

```powershell
node .tools/corepack/v1/pnpm/10.19.0/bin/pnpm.cjs install --frozen-lockfile --offline
node .tools/corepack/v1/pnpm/10.19.0/bin/pnpm.cjs typecheck
node .tools/corepack/v1/pnpm/10.19.0/bin/pnpm.cjs --recursive --workspace-concurrency=1 --if-present test --maxWorkers=1
node .tools/corepack/v1/pnpm/10.19.0/bin/pnpm.cjs build
node scripts/verify-migrations.mjs
node scripts/check-doc-links.mjs
```

## Что остаётся

Независимое окно не зарегистрировано, collection не открыт, H2 не активирована. Отрицательный development result, старые пороги и frozen artifacts сохранены. Требуются verified gameplay-start evidence, полный exposure ledger/denominator, заранее выбранные scope/window, реальный adapter и независимая проверка качества.

**Следующий срез: S3-04/post-draft-validation-readiness/committed-shadow-export.** Read-only экспорт SQL058/060/061 с SHA и воспроизведением сохранённых входов/чисел; отдельная SQL059-привязка к фактической карте, без пересчёта после исхода и без размножения одной карты несколькими попытками. Это подготовит проверяемые записи для независимого теста; само по себе не даст допуска модели. **GPT-6 Astra · High.**
