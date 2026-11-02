# S3-03/V1 — проверяемый снимок release-данных

Обновление 2026-11-02: [source-bound evaluator и отдельный first-result/revision journal](S3_03_V1_RELEASE_EVALUATION.md) реализованы следующим срезом. Появились evaluate/revise и export журнала, `check.scoringImplemented:true`. Описание ниже сохраняет историю capture checkpoint; полный executable freeze и реальная оценка всё ещё не завершены.

Checkpoint 2026-11-02. Реализован отдельный `release:execute check|capture|verify`: он связывает зарегистрированный план, неактивный kernel, исходные ответы discovery/detail и полный локальный inventory. **Scoring, журнал первой release-оценки и окончательный executable freeze ещё не реализованы.** Весь S3-03 остаётся открытым; пользовательские вероятности null.

## Состав снимка

`V1DataRepository.exportReleaseInventory` читает карты, source receipts, verified outcomes, canonical identities, series aliases и native league/team IDs в одной repeatable-read транзакции. Записей в БД нет. Generic window отделён от прежнего `development_only` export; старый экспорт и его policy сохранены. Ограничения: 5000 карт/series aliases, 20000 field observations; превышение останавливает экспорт, не обрезает выборку молча.

Каждый local map ID имеет ровно одну metadata-строку. Неполные/непригодные карты сохраняются в inventory. Внутренний fingerprint проверяется полным повторным вычислением. SQL snapshot может отражать текущие canonical corrections; фактический capture и source clocks записаны отдельно от `snapshotAt`. Это conditional reconstruction, не доказательство исторически известного состава.

Все discovery runs из закреплённого union повторно читаются с проверкой SHA, порядка запросов, receipts и ledger. Все необходимые detail batches по 50 ID обязательны; проверяются исходные bytes, reference catalogues, match outcomes/accounts/start/completion/event/teams, clocks и связь с тем же union. Пересчитанный self-hash не заменяет внешние SHA и повторную проверку источников. Повторные и пропущенные batches отвергаются.

Target inventory объединяет обнаруженные возможные targets и локальные карты в зарегистрированных event/time windows. Неизвестная локальная лига при подходящем времени сохраняет карту как возможный target. Пропущенные импорты, неудачные source fetch, конфликтующие facts/series, local targets без discovery и недостаточная история остаются в знаменателях покрытия. Все ранее просмотренные development IDs должны присутствовать; их попадание в target scope исключается. Team A — меньший **числовой canonical team ID**, независимо от стороны.

## История признаков и тестовые серии

Новый `prepareV1MapHistory` использует прежние проверки pro/outcome/identity/receipt, но не переносит непригодность одного члена серии на исторические карты его соседей. Shared Elo builder по-прежнему использует только карты, **завершённые строго раньше** target cutoff, с минимумом 5 карт на игрока. История профессиональных турниров других уровней сохраняется.

Целые серии исключаются только из target selection: outside-window sibling, конфликт aliases, переход между events или непригодный target закрывают связанную серию для оценки. Это не удаляет ранее завершённую корректную карту из истории следующей карты. Конфликт фактов собственного captured detail исключает именно эту карту из истории. Неудачный HTTP-запрос сам по себе не отменяет независимо подтверждённый historical receipt.

Binding сохраняет причины, coverage, fingerprints признаков и истории; метрик и вероятностей в нём нет. `remoteCompleteness:unknown` и `sourceHistoryCompleteness:only_explicitly_supplied_runs` остаются явными: объединение предоставленных captures не доказывает полную историю API. `dataReadyMaps` — готовность данных, не количество успешно оценённых прогнозов.

## Команды

После `pnpm shared:build` прямой CLI и alias имеют одинаковый контракт:

```powershell
pnpm release:execute check .tools/v1-release-execution-files.json CONFIG_SHA256
pnpm release:execute capture .tools/v1-release-execution-files.json CONFIG_SHA256 .tools/v1-release-capture.json
pnpm release:execute verify .tools/v1-release-execution-files.json CONFIG_SHA256 .tools/v1-release-capture.json CAPTURE_SHA256
```

Config содержит `planPath/planSha256`, `cataloguePath`, `developmentPath`, `candidatePath/candidateSha256`, `evidence: { configPath, configSha256, unionPath, unionSha256, batches: [{ directory, manifestSha256 }] }`. Catalogue/development hashes берутся из плана. Все SHA — от точных UTF-8 bytes, не от повторно сериализованного JSON. Source paths и полные captures остаются локально.

`check` проверяет план, источники его регистрации и kernel против текущего compiled code. Он **не читает release source files**: `sourceEvidenceChecked:false`, `scoringImplemented:false`. Поэтому конфигурацию с ещё не созданными будущими source files можно проверить заранее; успешный check не подтверждает их наличие.

`capture` и `verify` проверяют реальные часы сразу после чтения config и закреплённого plan file, **до** candidate/evidence/capture/DB/output. Для [зарегистрированного плана](evidence/s3-01-v1-release-plan.json) разрешено не раньше **2 декабря 2026, 03:00 МСК**. Capture использует DATABASE_URL, exclusive output и fsync; при технической ошибке возможен пустой/неполный файл, требуется новое имя. Максимум capture — 64 MiB. Verify полностью offline, без DB, проверяет также текущий execution-code manifest, включая вложенные ingestion adapters. Команды `evaluate` здесь нет.

Сам fingerprint не является подписью или внешним подтверждением времени. Владелец хранит доверенные file hashes и сохраняет версии кода; source receipts необходимо архивировать вместе с capture.

## Версии и следующий шаг

Первый [kernel artifact](evidence/s3-03-v1-kernel-candidate.json) и его [проверка](evidence/s3-03-v1-kernel-verification.json) сохранены без изменений. Добавление release contracts и DB adapter меняет его code manifest: проверять старый kernel против нового checkout нельзя. Новая ревизия kernel фиксирует текущий код, сохраняя Elo parameters, feature/quality policy, release plan и development bytes. Обе ревизии остаются inactive, `executableFreeze.complete:false`.

[Kernel r2](evidence/s3-03-v1-kernel-candidate-r2.json) зарегистрирован 2026-11-02T14:26:23.615Z, SHA `86264ef1f6ac4b39dfcf2fd2972d7704b1750cdb135b486e5531a2b536202f43`. Это новая регистрация текущего kernel code, не новая оценка и не изменение критериев качества.

```powershell
pnpm candidate:v1 verify docs/evidence/s3-03-v1-kernel-candidate-r2.json 86264ef1f6ac4b39dfcf2fd2972d7704b1750cdb135b486e5531a2b536202f43 docs/evidence/s3-01-v1-release-plan.json a4636dac08d439301c32f6f6d61303b10c5fe6f5f4486e5c1d71f67f84a0cbef .tools/v1-release-leagues-20261102.json .tools/v1-data-export.json
```

Следующий точный срез: **S3-03/V1-release-evaluation** — source-bound вычисление метрик и атомарный журнал первого результата/явных revisions, затем регистрация полного executable до 20 ноября. Журнал E1 и будущий пользовательский журнал прогнозов S3-07 остаются отдельными контрактами. Реальная независимая оценка выполняется только после зарегистрированного окна.

Проверки и hashes текущего среза фиксируются в [evidence](evidence/s3-03-v1-release-evidence.json) и [PROGRESS](PROGRESS.md). Синтетические тесты подтверждают механику, не accuracy или coverage будущего турнира. Новых provider calls/imports/активаций в этом срезе нет; последний live source audit — [S3-02](evidence/s3-02-v1-features.json), одна историческая pro-карта и три HTTP 200.

QA PASS: frozen install/typecheck/build,634 unit/CLI и23 isolated PG tests,23 migration checksums. Evidence SHA `6989f059dd38f0a4694890dfed3287b74819422edbf667108786ff3429dc95cd`. Все232 development feature rows, archived E0 result,8 защищённых артефактов и21 DB table fingerprints сохранены. E2E/Python не запускались; UI/HTTP/fitting не менялись.
