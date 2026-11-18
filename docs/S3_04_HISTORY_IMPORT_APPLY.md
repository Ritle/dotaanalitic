# S3-04 — перенос дополнительной истории в рабочую БД

13 ноября 2026 выполнен [закреплённый план](evidence/s3-04-history-import-apply-proposal.json) после успешной пробной загрузки. Добавлены ровно 28 профессиональных карт,280 строк участников,15 серий и 2 команды. Рабочая база выросла с 2232 до 2260 карт. Проверены 30 исходов:28 новых карт и 2 прежних соседних карт серий. Всего затронуты 16 серий. Пять неоднозначных карт по-прежнему исключены.

## Происхождение и сохранность

Исходные HTTP-байты старых наблюдений не восстановлены и не объявляются сохранёнными. У replay-проекции собственный SHA и adapter `opendota-projection-replay-v1`; SHA/endpoint/время исходного наблюдения остаются отдельно. `known_at`, canonical patch и номер карты не выдумываются. Все 75 аккаунтов до импорта имели подтверждённые ссылки; новые identity links импорт не создавал.

Миграция 057 добавляет две immutable таблицы: `history_projection_imports` и `history_projection_import_completions`. Первая хранит exact scope, исходную lineage, SHA входов/кода/backup **до** первой записи карты; вторая — итог с привязкой 83 созданных receipts к original/projection SHA. Эти таблицы не участвуют в обучении или выдаче вероятностей. Старые миграции не менялись.

До импорта создан приватный dump, затем восстановлен во временную БД. Все 104 таблицы public/pgboss восстановленной копии совпали с исходным снимком. Dump и fingerprints берутся из одного exported PostgreSQL snapshot. Временная БД удалена. Резервная копия хранится в ignored `.tools/s304-history-import-apply-r1/private-before.dump`; её нельзя публиковать: она содержит личные данные сервиса.

Прежние 2232 карты и их участники совпали построчно по fingerprint. Изменились только 10 разрешённых импортных таблиц и две новые записи аудита. Три real prediction snapshots, одна Live-оценка, модель, account evidence, очередь и frozen R1 dataset/fit/evaluation сохранены. Первое добавление —28accepted; последующее связывание с сериями —28accepted; третий проход —28duplicate с полным равенством строк 104 таблиц. Пропуски sequence IDs от INSERT ON CONFLICT не являются дублями строк.

Результат не переобучает модель и не подтверждает прирост точности. Старый оценочный набор уже использован в разработке и не становится новым слепым holdout.

## Изменённые файлы

- `tools/research/post-draft-history-import-apply.mjs`: preflight, backup/restore, репетиция, рабочий импорт через прежние IngestionService/SeriesProvisionRepository, OutcomeVerifier, immutable audit, offline/DB verify.
- `tools/research/post-draft-history-apply-policy.mjs`: exact scope, разрешённые отличия справочников, allowlist таблиц, проверка итогового отчёта.
- `packages/db/migrations/057_history_projection_import_audit.sql`: журнал регистрации и завершения, защита UPDATE/DELETE.
- `tests/node/post-draft-history-apply.test.mjs`, `packages/db/tests/history-projection-audit.integration.test.ts`: негативные и положительные проверки границ/immutability.
- Документация, план, PROGRESS/PROJECT_STATE и evidence. Frozen package JS, исходный dry-run и старые артефакты не редактировались.

## Особенности запуска

С момента первоначального плана добавились три локальные организации без OpenDota ID: PARIVISION, Froglings и Team Liquid. Проверка разрешает только такие посторонние ручные записи при полном совпадении прежних справочников, identities/maps и пересобранного плана. Новая команда с внешним ID, изменение прежней записи или изменение плана требуют нового разбора; молчаливого объединения по имени нет.

Первая репетиция остановилась на несовпадении backup с fingerprint, снятым отдельным чтением при работающем сервисе. Импорт карт не начинался. Неуспешный каталогr1 сохранён. Исправлено согласование snapshot; репетицияr2 полностью прошла. Перед рабочим переносом API и player-history worker были кратко остановлены; общий organization/map worker не запускался. После выполнения API/worker автоматически возобновлены, health ok, worker ready. Публичных API-запросов источникам в импортном процессе —0.

Режим run отказывается использовать существующий каталог и не перезапускает завершённый импорт. При неожиданной ошибке промежуточные receipts/attempt files остаются для разбора; автоматического отката рабочей БД или слепого повторного запуска нет.

## Проверки

11 целевых Node-тестов (4 новых+7replay) PASS; новый real PostgreSQL integration-тест immutability PASS. Полный запуск того же инструмента в restored clone PASS. Рабочий запуск, независимый SQL-пересчёт 28/280/30/16/15/2/83, offline verify и DB audit verify PASS. Исходные import plan/dry-run остаются воспроизводимыми. Установка --frozen-lockfile --offline, typecheck, 978 пакетных тестов и build PASS; предупреждения сборки: аннотации Zod и размер web chunk >500 kB.

UI и API-контракты не менялись; отдельный браузерный suite для этой задачи не запускался. Проверено восстановление работающего сервиса и доступность localhost.

```powershell
node --test tests/node/post-draft-history-apply.test.mjs tests/node/post-draft-history-replay.test.mjs
node tools/research/post-draft-history-import-apply.mjs verify
node --env-file-if-exists=.env tools/research/post-draft-history-import-apply.mjs verify-db
```

Полные закрытые отчёты: `.tools/s304-history-import-apply-r1` и `.tools/s304-history-import-apply-rehearsal-r2`. [Публичное сводное evidence](evidence/s3-04-history-import-apply.json) не содержит дамп, owner/session данные или DB URL.

## Следующая задача

S3-04/history-coverage-check — пересчитать, какие дефициты ранней истории закрыты добавленными 28 картами, и подготовить границы R2; только диагностика покрытия, без обучения, повторного scoring старого holdout и активации. GPT-6 Astra · High.
