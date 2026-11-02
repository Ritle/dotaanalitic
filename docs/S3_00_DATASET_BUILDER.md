# S3-00 — offline подготовка неизменяемых датасетов

**Область:** основной текст описывает прежний strict builder. С2026-11-02 отдельно реализован S3-01/V1-data, описанный в последнем разделе: conditional player-Elo dataset, без обязательных patch/role/draft inputs. Strict поведение не изменено.

**Дополнение S3-01:** текущая preparation policy — `strict-context-preparation-v2`, split policy — `explicit-windows-provider-series-v2`. Все canonical aliases одного provider series ID проверяются вместе, включая aliases без карт и siblings вне окна. Старые frozen snapshots сохраняются; новый независимый audit сообщает ограничение legacy v1. Формат input остаётся `prepared-context-v1`. Подробности, CLI аудита и открытый empirical gate: [S3-01](S3_01_SPLIT_AUDIT.md).

`OutcomeVerifier` и `DatasetBuilder` подготавливают контекст **одной профессиональной карты**, отдельную проверенную метку и воспроизводимый manifest. Формат `prepared-context-v1`: `input_features={}`, `featureState/historyState=not_built`, `trainingReady:false`, `deployable:false`. Числовой feature builder остаётся S3-02, обучение и выпуск моделей — S3-03..06. Сценарии, отчёты, прогнозы и пользовательские оценки не читаются как источник примеров.

## Источник и время

Добавочная **018_outcome_verifier.sql** вызывает authoritative `assert_training_map_evidence` из012. SQL001–017 не изменены. Проверяются положительный pro-статус, завершение к `snapshotAt`, обе различные организации, отсутствие ingest conflict, matching immutable OpenDota receipt и professional/premium league reference. Receipt и reference получены не позже snapshot. Повреждённый/поздний receipt не заменяет подходящее доказательство; отсутствие доказательства даёт причину исключения. Неожиданные ошибки SQL не маскируются.

`cutoffAt` каждой карты равен началу. Текущие outcome/duration/игровые показатели не попадают в input snapshot. Pre-match не получает текущих героев/first pick/draft order. Strict policy требует доказанные lineup, teams и patch; post-draft дополнительно требует10 разных героев с разрешённой стадией и known-at не позже начала. Только `strict_verified_asof`: owner assertions и восстановленная после игры пятёрка исключаются. Post-draft timestamp представлен датированной typed heroes proof, а не временем fetch итоговых match_players. Полный draft timeline не требуется.

Патч разрешается по проверенным release/coverage интервалам. Source-account identities разрешаются на cutoff; proofs после snapshot исключаются. Canonical IDs должны совпасть с заявленным составом по native slots. Команды сверяются с фактическими сторонами label, post-draft герои — с наблюдёнными героями тех же слотов. Эти проверки соответствия используют завершённую карту для допуска примера, не для заполнения неизвестного контекста. Роли сохраняются только при подтверждённой доступности и соответствии составу. Hero eligibility, history/features и model quality ещё не оценены.

Start точнее миллисекунд исключается явно, без округления через строгую границу. `snapshotAt` — горизонт source evidence, не реконструкция прежнего состояния всей БД: используется текущая canonical revision и видимая транзакции история. Поздний conflict/correction может исключить карту из нового build, но не изменить старый frozen dataset.

## Разбиение и покрытие

Config задаёт четыре окна: `[fromAt,trainUntil)`, затем calibration, validation, test до `toAt` exclusive. Неизвестная серия исключается. Membership требует совпадения ненулевого provider series ID receipt с canonical series и двух организаций. Все локально известные карты серии, включая находящиеся вне интервала, проверяются на границы. Пересекающая границы серия исключается целиком. Серии не угадываются по времени или названиям команд.

Полнота локального корпуса относительно всех сыгранных карт не доказана; широкий corpus audit остаётся P0 gate. `maxMaps` (default1000, максимум5000) ограничивает кандидатов и полную локальную series inventory. Переполнение даёт unavailable без truncation. Summary содержит N кандидатов/пригодных/исключённых, причины каждой карты, N по split и verified patch. Пустая пригодная выборка не создаёт dataset row.

## Freeze и воспроизводимость

Preview/build читают один repeatable-read snapshot. Build атомарно создаёт header, одну строку на map/stage/version и freeze. Ошибка откатывает всё. `DatasetRepository` принимает общий Executor, сохраняя собственную транзакцию для прежних standalone вызовов.

`source_manifest.inputs` хранит typed inputSnapshot, отобранные context/patch/identity proofs с clocks и input SHA. Рядом, **вне inputSnapshot**, находятся фактические native slots/source accounts/heroes, receipt hashes/versions, series evidence и normalizer quality assessment/version/hash. `assessedAt` — время выполнения нормализатора, не историческое known-at. Audit-данные нельзя подавать целиком как признаки. Manifest включает policy, exclusions, registry/identity revisions, code revision и незакрытые feature/model gates.

Label отдельно в `training_dataset_maps`, `labelVerifiedAt=snapshotAt`; SQL повторно проверяет clocks/источники. Одинаковые request/code/data дают одинаковый fingerprint и прежний frozen dataset ID. Временные строки дубля откатываются до savepoint; concurrent unique/serialization race повторяет всю транзакцию не более двух раз. Изменение label/proof/corpus/config/code создаёт новую версию. Terminal headers/examples остаются immutable.

Canonical bytes — прежний `training_dataset_content(id)::text`, формат `pg-jsonb-dataset-v1`. Export проверяет SHA-256 и пишет точные UTF-8 bytes без переформатирования/newline. Существующий файл не перезаписывается. CLI code revision — SHA исполненных compiled DB/contracts файлов, SQL migrations и самого CLI, включая uncommitted executable changes. Зависимости закреплены lockfile, новых библиотек нет.

## CLI

Сначала `pnpm install --frozen-lockfile` и `pnpm db:migrate`. Пример локального config:

```json
{
  "stage": "pre_match",
  "teamASide": "radiant",
  "fromAt": "2023-01-01T00:00:00.000Z",
  "trainUntil": "2023-07-01T00:00:00.000Z",
  "calibrationUntil": "2023-09-01T00:00:00.000Z",
  "validationUntil": "2023-11-01T00:00:00.000Z",
  "toAt": "2024-01-01T00:00:00.000Z",
  "snapshotAt": "2026-10-31T20:00:00.000Z",
  "maxMaps": 1000
}
```

Это пример формата, не рекомендуемый holdout или обещание наличия данных. Сохраните как `reports/dataset-config.json`:

```powershell
pnpm dataset:prepare preview reports/dataset-config.json
pnpm dataset:prepare build reports/dataset-config.json
pnpm dataset:prepare export <dataset-uuid> reports/dataset-export.json
```

Preview не пишет datasets. Exit0 — успех,3 — unavailable,2 — usage/missing environment,1 — config/операционная ошибка. Ошибки не печатают connection string или SQL payload. Нет HTTP API, обучения, активации или расписания. CLI не принимает features, labels, assumptions или synthetic flag. Изолированные тесты явно используют `syntheticOnly:true`; метка остаётся в manifest, deployable всегда false. Маркеры synthetic/fixture/demo в evidence отклоняются обычным builder; это дополнительная защита, не доказательство подлинности произвольных вручную внесённых данных.

## Проверки и ограничения

`pnpm test:dataset-builder` проверяет OutcomeVerifier, builder и прежнюю durable boundary на PostgreSQL: clocks/source proof, unknown side/pro/identity, strict context, swapped sides, pre/post separation,10 прогнозов одной карты, дубли/конкуренцию, серии, rollback, late import/correction, SHA и CLI export. Синтетика существует только в временных test databases. Pure split/contract tests входят в `pnpm test`.

[Live audit](S3_00_SOURCE_AUDIT.md) получил10 карт, но не доказал canonical identity, verified patch или lineup/draft known-at. Corpus gate (отдельная запись S1-08 в v8 дополнении плана) и S1-07 остаются открыты. Прогнозы недоступны; подготовка структуры не закрывает эти gates. Следующий ticket — **S3-01: широкий корпус и проверка temporal/series splits**, модель **GPT-6 Astra · Extra High** по проектному routing guide.

## S3-01 V1 data — отдельная подготовка корпуса

Реализовано2026-11-02 по [утверждённой границе V1](../TECHNICAL_SPEC.md). `V1DataRepository` читает рабочую БД в repeatable-read transaction через прежний OutcomeVerifier; `prepareV1Data` независимо проверяет и замораживает отдельный формат `v1-development-dataset-v1`. Не пишет training_dataset_versions/models, не запускает fitting/scoring. Старые DatasetBuilder, E0/E1, SQL и их форматы не изменены.

Профиль `pre-match-player-elo-data-v1`, policy `conditional-player-history-preparation-v1`, purpose **development_only**. Экспорт сохраняет полный ограниченный inventory, actual native slots/account IDs и их source-receipt cross-check, verified outcomes, canonical identity proofs, provider-series aliases, реальные source clocks, request/code hashes, assessments с причинами и отдельные inputs/labels. Ни heroes, ни patch/roles не входят в inputs. Состав — reconstructed условие; current same-account links не превращаются в historical known-at. Label completion clock нужен только для определения момента доступности прошлых исходов по явно указанному event-time assumption.

Политика исключает unknown/conflicting identity, неполные/повторные slots/accounts/canonical players, неверный pro/outcome/source binding, unknown/конфликтные series. Проверяются все локальные aliases и siblings за пределами окна: непригодный участник или выход серии за границу исключает целую серию. Перекрывающиеся по времени **разные** серии допустимы: history ограничена `completed_at < target.started_at`, а не порядком импорта. Это отличается от более консервативного E0 overlap rule; E0 не изменялся. Remote completeness остаётся unknown.

`historyCoverage` считает доступные ранее **eligible maps из выбранного окна**, всего и для каждого из десяти canonical игроков. Начальные карты без истории остаются материалом warmup; число предыдущих карт не является оценкой точности или готовым coverage gate. Никакого автоматического выбора train/test и никакой вероятности: `split=unassigned_development`, `featureState=not_built`, `coverageGate=not_registered`, `trainingReady=false`, `deployable=false`.

### Команды

Создать локальный конфиг (даты — пример, не тестовый протокол; snapshot не может быть в будущем):

```json
{
  "schemaVersion": 1,
  "profile": "pre-match-player-elo-data-v1",
  "purpose": "development_only",
  "fromAt": "2020-01-01T00:00:00.000Z",
  "toAt": "2026-11-01T23:00:00.000Z",
  "snapshotAt": "2026-11-01T23:06:07.534Z",
  "maxMaps": 5000
}
```

```powershell
pnpm dataset:v1 preview reports/v1-config.json
pnpm dataset:v1 export reports/v1-config.json reports/v1-dataset.json
pnpm dataset:v1 verify reports/v1-dataset.json <SHA256_из_export>
```

`preview` печатает сводку, `export` создаёт новый файл через exclusive write, `verify` проверяет внешний SHA, внутренний fingerprint и заново вычисляет eligibility/history без БД. Привязки code hashes сохраняются для воспроизводимости; verify не скачивает и не исполняет код из артефакта. Exit0 — подготовлен/проверен,3 — валидный пустой результат,2 — неверное использование,1 — ошибка. Export может сохранить пустой диагностический результат с exit3. CLI не принимает synthetic bypass, готовые признаки или labels. Проверка маркировки synthetic/fixture/demo — дополнительный guard, а не доказательство подлинности произвольного файла.

Лимиты: inventory всех локальных maps/series не более maxMaps (1..5000), source facts не более20000, один map не более2000 fact clocks, config64KiB/artifact64MiB. Превышение — явная ошибка без усечения. Профиль сохраняет conservative whole-local-series policy, не выдаёт частичный экспорт за полный.

### Реальный результат и приёмка

Чтение существующего корпуса, новых provider HTTP0: **232/232 eligible maps,122 series,197 canonical players**, exclusions0. История всех10 игроков есть у198 карт, частичная у28, отсутствует у6. Source fact clocks11129, knownAt nonnull0 — не backdate-ились. Пустой patch registry не препятствует этому профилю. [Сводка, все map IDs, source/code SHA и coverage](evidence/s3-01-v1-data.json).

Полный local export `.tools/v1-data-export.json`, SHA256 `79ae50020134a30ad822d9780934518e64010fb85fc367885d3e12092c70eed5`, internal fingerprint `978658a3d46219b7e32f117f16f67a85dc9b0e94785d6cef14e58acf5ab2b2bb`. Повторный экспорт byte-identical, offline verify PASS, перезапись отклонена;21 DB table fingerprints и E0/E1/STRATZ evidence неизменны. Это отобранный ранее корпус, не репрезентативная оценка и не untouched release test. Registry datasets/models остаются0.

Тесты: pure profile/clock/series/identity/zero/forged-report cases, offline CLI,5 PostgreSQL V1 tests и18 regression tests legacy strict/E0. При live preview обнаружен false-positive synthetic guard по собственному ключу syntheticOnly; failing test воспроизвёл ошибку, исправленный guard проверен повторно и на реальном экспорте. Полные результаты проверок — [PROGRESS](PROGRESS.md). Следующая задача **S3-01/V1-evaluation**: заранее зарегистрировать release gate и независимую проверку, реализовать E1 collector/scoring guard по неизменному протоколу; готовность данных не активирует модель.
