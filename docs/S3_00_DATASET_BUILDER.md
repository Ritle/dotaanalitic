# S3-00 — offline подготовка неизменяемых датасетов

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
