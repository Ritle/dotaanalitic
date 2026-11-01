# S3-01 E0 — offline исследование player-mean Elo

Владелец явно выбрал [отдельный research scope](S3_01_E0_RESEARCH_PROPOSAL.md). Реализация и первый эксперимент завершены 2026-11-01. Это отдельный cohort `research_event_time_reconstructed`; S1-07 и production S3-01 остаются открытыми.

## Фактический результат

Из рабочей PostgreSQL экспортированы 36 настоящих профессиональных карт, 28 известных provider-серий и текущие числовые identity proofs. Все 36 прошли **исследовательские** проверки; исключений в этом запуске нет. Это не 36 strict training examples. Новый provider HTTP не выполнялся.

До вычисления метрик сохранён [config](evidence/s3-01-e0-config.json): начало окна 2020-01-01 UTC, граница holdout 2026-10-01 UTC, конец и snapshot 2026-11-01T20:53:15.000Z. Конфигурация существующего Elo не подбиралась: initialRating=1500, K=32, scale=400, `validation:unvalidated`. Ни калибровки, ни выбора лучшего варианта по этим данным не было.

| Показатель | E0 | Constant-prior baseline |
|---|---:|---:|
| Карты начального накопления рейтинга | 20 | — |
| Проверочные карты / серии | 16 / 8 | 16 / 8 |
| Brier, меньше лучше | 0.23744452564934726 | 0.25 |
| Log loss, меньше лучше | 0.6679704734179476 | 0.6931471805599453 |

В одной проверочной карте все десять игроков ещё не имели истории в replay; в 15 хотя бы один имел. Это не означает полное покрытие всех игроков. 36 обновлений рейтингов применились после завершения соответствующих карт.

Результат показывает, что pipeline выполняется и воспроизводится. 16 карт из восьми серий в ранее собранном, нерепрезентативном корпусе недостаточны для вывода о полезности модели на будущих играх. Карты одной серии зависимы. Не оценены статистическая неопределённость, калибровка, patch drift и prospective accuracy; этот эксперимент не измеряет потери качества от исключения патча. `trainingReady:false`, `deployable:false`, `teamAWinProbability:null`.

Полные значения, map IDs, per-map feature fingerprints, receipt hashes, code hashes, assumptions и проверки: [публичный manifest](evidence/s3-01-e0-research.json). Полные входные evidence/clocks хранятся в ignored локальном export; manifest не заменяет этот файл для replay.

## Граница расчёта

- Один canonical match ID даёт одну карту. `OutcomeVerifier` заново проверяет реальный pro-исход и immutable source receipt; native team IDs, winner, revision, start/completion, source series ID и все десять source accounts должны совпасть с канонической записью. Участники определяются по slots 0..4/128..132, не по позиции массива. Unknown, anonymous, повторённые accounts/canonical identities исключаются.
- Identity разрешается по текущей проверенной числовой связи, полученной к snapshot. Это не доказательство исторического состава или раннего identity proof. Source known/fetched/recorded clocks сохраняются. У всех 2507 экспортированных field observations `knownAt` остался NULL.
- Историческая фактическая пятёрка считается известной **только как допущение E0**. Исход прошлой карты становится доступен Elo в реконструированный `started_at + duration`, хотя источник мог сообщить его гораздо позже. Этот отдельный research clock не записывается обратно в source evidence. Outcome текущей карты служит label и обновляет рейтинг лишь после её завершения.
- Рейтинг принадлежит игрокам; переход в другую организацию его не сбрасывает. Математика `replayElo` не менялась. Hero/patch признаки, веса, expected lineup/roles не добавлялись.
- Warmup/holdout разделяются целыми provider-сериями с проверкой aliases, включая aliases без локальных карт. Если хотя бы один известный sibling не подходит/вне окна, исключается вся группа. Серии, пересекающие границу holdout или интервалы других серий, исключаются целиком. Полнота удалённого provider-корпуса неизвестна: это проверка всех **локально известных** siblings.
- Holdout **prequential**: для каждой карты используются только более ранние завершённые карты, включая предыдущие карты holdout. Это не проверка навсегда замороженного рейтинга и не реализованный сервис live/between-map прогнозов. Окно определяется стартом карты; её label должен быть подтверждён к snapshot. Если toAt раньше snapshot, завершение после toAt не даёт обновления в replay до toAt.
- Baseline и Elo оцениваются на одних и тех же картах; baseline — постоянное математическое значение для сравнения ошибок, не пользовательский прогноз. При пустом warmup/holdout метрики NULL и причина. В отчёт не выводятся вероятности отдельных встреч. Параметры, метрики и provenance сохраняются раздельно.

## Экспорт и повторение

`ResearchEloRepository` делает SELECT в одной repeatable-read транзакции. Существующий SQL verifier использует `FOR SHARE`, поэтому транзакция не помечается PostgreSQL READ ONLY; INSERT/UPDATE/DELETE в экспортёре отсутствуют. Ни dataset, ни model registry не вызываются. Новых миграций и зависимостей нет.

Экспорт читает весь локальный inventory (до maxMaps=5000 карт и aliases); переполнение прекращает запуск, а не скрывает siblings усечением. Ограничены также field observations и размер файлов. Snapshot — зафиксированный текущий снимок чтения; команда не восстанавливает произвольное прошлое состояние изменяемых таблиц. После изменений БД для точного повторения нужен сохранённый export.

```powershell
pnpm research:elo export docs/evidence/s3-01-e0-config.json .tools/new-e0-export.json
# Взять artifactSha256 из stdout экспорта; использовать точный SHA, не fingerprint.
pnpm research:elo evaluate .tools/new-e0-export.json <SHA256> .tools/new-e0-report.json
```

Для сохранённого запуска, после сборки и сверки 12 code hashes из manifest:

```powershell
node scripts/research-elo.mjs evaluate .tools/s3-01-e0-export.json 726c7e256f81f31485cd4a99f6bbd4b96625ae7bff22309373522a693d91bc51 .tools/new-e0-replay.json
```

Offline evaluate не подключается к БД и не обращается к сети. CLI сначала сверяет SHA исходных bytes, затем UTF-8/JSON/schema и внутренний fingerprint. Для воспроизведения использовать ту же реализацию из code manifest; SHA файла сам по себе не удостоверяет истинность его содержимого. Файлы создаются через exclusive `wx`, существующий output не перезаписывается. Exit:0 — research complete/exported,3 — недостаточный cohort,2 — usage,1 — ошибка. В ошибках нет исходных credentials/payload. Fixture artifacts явно `syntheticOnly:true`.

Повторный настоящий экспорт и два offline вычисления совпали побайтно. Проверены SHA всех 12 файлов реализации/SQL. Count/content fingerprints 21 рабочей таблицы до/после совпали, dataset/model rows остались 0. Исторические SQL не изменялись; API/UI/worker не перенастраивались.

## Проверки и следующий шаг

Новые тесты:13 pure (target/future outcome leakage, swaps, player transfer, source/identity binding, duplicate maps, hash/order, series aliases/overlap/window, zero sample),2 offline CLI (replay без доступной БД, overwrite/SHA/UTF-8/secret redaction),5 disposable PostgreSQL (real verifier, source roster mismatch, inventory/snapshot limits, сохранение evidence и отсутствие записей). Synthetic fixtures живут только в тестах и отдельных временных БД.

Штатные проверки и итоговые команды записаны в [PROGRESS](PROGRESS.md). Отдельный DB suite:

```powershell
pnpm shared:build
node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run packages/db/tests/research-elo.integration.test.ts --testTimeout=30000 --maxWorkers=1 --no-file-parallelism
```

Следующий предлагаемый шаг S3-01 — заранее определить расширение реального pro-корпуса и новый независимый временной holdout, сохранив эти 16 карт как уже просмотренные. Не подбирать коэффициенты под E0 и не считать увеличение N закрытием исторических source/patch/lineup gates. Это следующий исследовательский срез, не разрешение опубликовать упрощённую production модель. S1-07 source mapping ветка остаётся остановленной до нового существенного evidence. Для дальнейшего temporal evaluation рекомендуется GPT-6 Astra · Extra High.
