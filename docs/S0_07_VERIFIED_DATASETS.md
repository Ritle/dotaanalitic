# S0-07 — проверенные метки и неизменяемые датасеты

## Граница реализации

Миграция 012 усиливает таблицы и функции из неизменной 005. Внутренний `DatasetRepository` предоставляет create/append/freeze/reject, Zod-контракты — manifest и запись одного примера. Это хранение подготовленных примеров, **не DatasetBuilder/OutcomeVerifier collector**, не публичный endpoint, не обучение и не автоматизация. S3-00 должен построить признаки и проверить их допустимость на cutoff; S3 quality gates необходимы до использования модели. Заморозка сама по себе не подтверждает feature eligibility.

## Метка из карты и источника

Writer не принимает `teamAWon`, prediction ID, probability или ручной outcome. Он вычисляет Team A win по каноническому `matches.radiant_win` и явным A/B IDs. SQL проверяет positively pro, завершение по start+duration, ненулевой winner, известные обе организации, отсутствие ingest conflict, совпадение cutoff со стартом, map data revision и snapshot series ID. Label verification происходит не раньше конца карты и получения source evidence, не в будущем. Receipt fetchedAt сохраняется отдельно и не объявляется историческим known_at признаков.

Каждая новая строка требует `outcome_receipt_id` с composite FK к той же канонической карте. На текущем этапе поддерживается только включённый OpenDota adapter: accepted/partial receipt должен совпадать по match ID, start, duration, winner, provider team IDs и league ID. Raw receipt и связанное immutable `pro_classification` с reference snapshot должны подтверждать professional/premium tier. `label_source` строго соответствует receipt. Свободная строка «verified», пользовательский guess или прогноз не заменяют источник, даже если угадывают реальный winner. Полнота героев/ростеров/драфта проверяется отдельно: label gate не становится глобальным training_eligible.

Новая proof не создаётся автоматически для старых строк. SQL 001–011 не изменены; legacy frozen snapshots остаются неизменными, их прежний fingerprint не переинтерпретируется в новый формат. Legacy building examples без достаточного receipt не пройдут новую заморозку. STRATZ остаётся выключен.

## Признаки, число примеров и split

Input features — плоский объект finite numeric/null значений, отдельный от label/source evidence. Null и zero различаются. Контракт и SQL блокируют явные названия target/current-map outcome; SQL также блокирует прямые draft поля в pre-match. **Это структурная защита, а не доказательство отсутствия leakage:** произвольное имя numeric feature не сообщает его происхождение. S3 должен закрепить список признаков, доступность исходных фактов, stage/lineup/patch/identity policies и одинаковый feature builder для offline/runtime. Синтетика не становится production training data и не может обходить published-model gates.

Primary key `(dataset_version_id,match_id)` сохраняет одну карту на stage/version, независимо от количества прогнозов или повторов append. Concurrent одинаковые append идемпотентны; изменённый input не перезаписывает прежнюю строку. Match ID нельзя переназначить, manifest/stage нельзя менять после добавления примеров. До terminal state пример можно явно изменить/удалить через SQL только с повторной проверкой invariants.

Известная серия целиком находится в одном split; exclusive lock родительского dataset сериализует конкурентные siblings. При freeze проверяется строгая хронология train → calibration → validation → test. Это не выбирает split автоматически, не устанавливает sample thresholds и не решает неизвестные series linkage: соответствующий policy/audit остаётся S3/S0-09.

## Заморозка, ревизии и SHA-256

Новый dataset начинается только building; готовый frozen header нельзя вставить напрямую. Freeze отказывает пустой выборке, повторно проверяет каждую текущую карту/proof/revision и блокирует append на время перехода. Одновременный append либо входит в полностью проверенный снимок, либо отклоняется после freeze. Frozen **и rejected** headers/examples нельзя UPDATE/DELETE или переносить в другой dataset. Повтор вызова repository.freeze возвращает прежний fingerprint без UPDATE.

`input_hash` и `dataset_fingerprint` рассчитываются через PostgreSQL SHA-256, формат **pg-jsonb-dataset-v1**. Канонические байты — UTF-8 строки `training_dataset_content(id)::text` (JSONB text), с UTC независимо от session timezone и отсортированными по bigint map ID строками. IDs/revisions в content представлены строками. Не пересериализовывать объект через обычный JSON.stringify для проверки этого hash: пробелы/числа/порядок ключей могут отличаться. Content включает versioned manifest, features/hash, labels, timestamps, receipt/source evidence и map/series revisions; исключает собственный fingerprint, случайный dataset UUID и lifecycle timestamps. SHA проверяется тестом также через Node crypto.

Исправленный canonical outcome/proof требует новой версии dataset. Старые labels/features/fingerprint не меняются; если correction случилась до freeze, stale building example отклоняется. Реальное разрешение provider conflicts — отдельный доверенный workflow, этот repository его не автоматизирует.

## Проверка и следующий этап

`pnpm test:dataset` использует real PostgreSQL и настоящий importer с **явно синтетическими** provider responses в отдельной временной БД. Проверяются guessed labels, clocks, pro/source/orientation, повторные записи, freeze/reject, concurrent races, серии/хронология, correction и SHA/timezone/bigint. Pure tests входят в `pnpm test`. Фактические результаты — [PROGRESS](PROGRESS.md), [PROJECT_STATE](PROJECT_STATE.md).

Перед использованием выполнить `pnpm db:migrate`; после 012 следующий SQL — 013+. В рабочей БД эта задача не создаёт dataset, training run, model или prediction. Следующая задача **S0-08: live API evidence audit**, затем S0-09 readiness. Рекомендуемая модель для ограниченного audit — **GPT-6.1 Sol · High**; выбор является проектной рекомендацией, поддержка effort проверена в [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
