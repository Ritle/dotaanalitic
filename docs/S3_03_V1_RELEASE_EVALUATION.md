# S3-03/V1 — расчёт качества и неизменяемый журнал

**Актуальное дополнение2026-11-02:** [полный executable freeze](S3_03_V1_EXECUTABLE_FREEZE.md) зарегистрирован отдельно. Новый report v2 допускает releaseGate true только после завершённой passed несинтетической оценки, сохраняя deployable false до отдельной активации. Legacy v1 сохраняет прежнюю семантику false. Ниже — исходный checkpoint журнала и его команды; прежний next-step уже выполнен.

Checkpoint 2026-11-02. Добавлены source-bound evaluator, миграция `024_v1_release_evaluation_journal.sql`, `V1ReleaseEvaluationJournal`, команды `release:execute evaluate|revise` и `release:journal list|export|export-capture`. Реальная release-оценка **не выполнялась**. Полный executable freeze ещё не зарегистрирован, поэтому `releaseGatePassed:false`, `deployable:false`, пользовательская вероятность null даже при достаточных метриках.

## Расчёт

Evaluator полностью воспроизводит [source capture](S3_03_V1_RELEASE_EVIDENCE.md), затем получает per-map историю с теми же исключениями и fingerprint. Только targets без причин отказа поступают в shared candidate scorer. Его feature fingerprint должен совпасть со снимком; несовпадение останавливает запуск, а не уменьшает N. Team A — меньший numeric canonical team ID; при Dire-A одновременно меняются порядок пятёрок и ориентация verified label.

Метрики считает прежнее фиксированное [ядро](S3_03_V1_CANDIDATE.md): Brier/log loss, baseline на тех же картах, calibration/reliability, paired whole-series bootstrap и temporal stability. Порогов и параметров Elo не меняли. Вычисленные per-map probabilities находятся только в offline evaluation report вместе с подтверждёнными labels; это не пользовательские прогнозы и не новые training labels.

Полный target ledger сохраняет missing/failed/conflicting/excluded карты. В source coverage учитываются **все** наблюдённые известные series aliases, включая конфликтующие. Математическое ядро принимает один series key на карту, поэтому его coverage хранится отдельно как `metricKernelCoverage`; решение дополнительно проверяет полный знаменатель source binding. Partial discovery даёт `DISCOVERY_INCOMPLETE`, недостаток source series coverage — `SOURCE_SERIES_COVERAGE`. Remote completeness остаётся unknown; известна только история явно предоставленных runs.

`evaluation.status:evaluation_complete` означает завершённый расчёт на доступных картах, **не** пройденный quality gate. `qualityDecision` бывает passed/failed/insufficient_evidence. При нуле пригодных карт status unavailable, metrics null, и результат всё равно сохраняется первым. Техническая ошибка replay/schema/hash не является результатом оценки и откатывает транзакцию. Conditional reconstructed lineups явно отделены от prospective forecasts.

## Первый результат и пересмотры

Отдельная таблица release-журнала не изменяет E1 journal или будущий пользовательский S3-07 forecast journal. Перед вычислением берётся plan-scoped transaction lock. Один capture SHA + scorer-code SHA имеет одну запись; повтор возвращает точные сохранённые bytes без scorer. Новый input/code после первой записи требует актуальных parent revision, parent report SHA и причины. Конкурентная ветвь с устаревшим родителем отказывается до расчёта.

Сохраняются точные capture/report bytes, hashes, candidate/binding/plan identities, scorer manifest, synthetic provenance, время и цепочка родителей. SQL защищает unique keys, parent FK/linear chain, запрет UPDATE/DELETE/TRUNCATE. Repository проверяет hashes и связи при восстановлении, запрещает подмену candidate, превращение synthetic в real и флаги публикации. Это доверенная внутренняя boundary; публичного HTTP приёма произвольных reports нет.

CLI публикует метрики только **после commit**. Новый output резервируется эксклюзивно; при отказе БД может остаться пустой файл. Если commit прошёл, а запись файла не удалась, результат восстанавливается через журнал без повторного вычисления. При неоднозначной ошибке соединения проверить `list` и повторить те же входы с новым output; такой повтор идемпотентен. Для исправления нужен явный `revise`, а не удаление старой записи.

## Команды

```powershell
pnpm release:execute evaluate config.json CONFIG_SHA capture.json CAPTURE_SHA new-report.json
pnpm release:execute revise config.json CONFIG_SHA capture.json CAPTURE_SHA revision.json REVISION_SHA new-report.json
pnpm release:journal list PLAN_FINGERPRINT
pnpm release:journal export PLAN_FINGERPRINT 1 recovered-report.json
pnpm release:journal export-capture PLAN_FINGERPRINT 1 recovered-capture.json
```

Revision JSON: `{ "parentRevision": 1, "parentReportSha256": "<64 hex>", "reason": "Причина пересмотра не короче 10 символов" }`. SHA считаются по точным bytes файлов. `DATABASE_URL` нужен для evaluate/revise/journal; verify source capture остаётся offline. `check` теперь сообщает `scoringImplemented:true`, но по-прежнему `sourceEvidenceChecked:false` и не подтверждает наличие future-source файлов или таблицы журнала.

Реальные часы проверяются до чтения capture/source/revision, DB и output. Для неизменного [release plan](evidence/s3-01-v1-release-plan.json) — не раньше **2 декабря 2026, 03:00 МСК**. Дополнительно repository сверяет capture/snapshot с часами PostgreSQL. CLI clock override отсутствует. Scorer manifest включает compiled contracts/prediction/db/ingestion с вложенными adapters, CLI/helpers, lockfile/package и SQL migrations. Старые artifacts требуют своей версии кода; автоматического признания старого manifest новым нет.

## Состояние и следующий шаг

Миграция 024 только добавляет отдельный журнал и его guards; SQL 001–023 не переписаны. Старые E0/E1, development export, kernel r1/r2 и evidence сохранены. Модель не активирована, новых pro imports или provider calls нет. Synthetic fixtures проверяют механику, не реальную точность. Ранее выполненный live source audit описан в [S3-02 evidence](evidence/s3-02-v1-features.json).

[Kernel r3](evidence/s3-03-v1-kernel-candidate-r3.json) фиксирует новый contracts/DB code manifest: registered2026-11-02T14:43:50.597Z, SHA `02dc6dd1b68cfd67e1d6cc2d1ea397f0dcb1ebb55eff8a5da8d7f118ede7399a`. Параметры модели и criteria unchanged; это не полный executable freeze. Реальный `check` и ранние evaluate/revise проверены с `.tools/v1-release-evaluation-files.json`, где будущие source refs пока placeholders. Файлов результатов не создано; working E1/release journal0, models0.

```powershell
pnpm candidate:v1 verify docs/evidence/s3-03-v1-kernel-candidate-r3.json 02dc6dd1b68cfd67e1d6cc2d1ea397f0dcb1ebb55eff8a5da8d7f118ede7399a docs/evidence/s3-01-v1-release-plan.json a4636dac08d439301c32f6f6d61303b10c5fe6f5f4486e5c1d71f67f84a0cbef .tools/v1-release-leagues-20261102.json .tools/v1-data-export.json
```

**Следующий точный срез — S3-03/V1-executable-freeze:** регистрация и проверка полного исполняемого manifest до начала test window, его связь с kernel/plan/capture/evaluation и окончательный release-gate contract. S3-03/S3-01 evaluation остаются открытыми до независимой реальной оценки. Затем отдельно S3-05/06 activation/snapshots и обязательный S3-07 forecast journal.

QA PASS: frozen install/typecheck/build,639 unit/CLI tests и35 isolated PG tests,24 migration checksums. [Evidence](evidence/s3-03-v1-release-evaluation.json), SHA `9dd1f3a8b7dac2ccc2dcab9719356ae7358ab383c0dbbf3087bcbcb2fd57370c`. Все10 защищённых артефактов, E0 result,232 feature rows и21 рабочая таблица сохранены. E2E/Python не запускались, UI/HTTP/fitting не менялись.
