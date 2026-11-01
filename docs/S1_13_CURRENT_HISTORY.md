# S1-13 — текущая описательная pro-история

Загружена ограниченная выборка **10 завершённых карт** PARI UNIVERSE by FISSURE (`leagueid=20395`, provider tier `professional`) за29–31 октября2026. В рабочей БД добавлены9 карт, а существующая9069021061 обновлена с текущими identity resolutions. Повтор той же партии распознал10 дубликатов и сохранил data revisions. Проверка реальных отчётов: по5 карт Spirit/Yandex и десяти выбранных игроков; у DM —0 наблюдений и `winRate:null`.

## Источник и выборка

Использован документированный OpenDota [GET teams/{id}/matches](https://opendota.apidocumentation.com/), затем подробные `/matches/{id}`, `/leagues` и `/heroes`. Два numeric team IDs:7119388/9823272. Cutoff фиксирован до запросов:2026-11-01T01:10:19.996Z; завершённые по discovery записи сортируются по start_time/ID и выбираются по очереди из организаций с дедупликацией. Отбор не зависит от победителя или качества подробного payload. Из1965 уникальных discovery candidates выбраны10; это **не полная карьера игроков** и не репрезентативный ML-корпус.

Обязательный `audit-prediction-sources.mjs` выполнен на живых данных: **14 HTTP200** через durable PostgreSQL quota,2 discovery +2 reference +10 detailed responses; ошибок/повторов HTTP нет. SHA-256 полного capture: `18bb97dbf8676c966066dbe2347210c333b3d992878be67f42c3049c79622f65`. [Аудит](evidence/s1-13-current-history-audit.json) содержит coverage и точные10 IDs. Наблюдаемые исходы, завершение,10 source accounts,10 final heroes, обе организации и positive pro tier есть10/10. Canonical IDs, историческая доступность lineup/draft и проверенный патч этим аудитом не подтверждаются.

Реестр аккаунтов S1-12 сообщает6 кандидатов Yandex, но в выбранных пяти фактических картах участвуют5: Maladych/Saksa/watson/AMMAR_THE_F/CHIRA_JUNIOR. Это наблюдение о завершённых картах, не гарантия состава предстоящей встречи. DM не исключён из каталога и не получает выдуманную статистику.

## Импорт и воспроизводимость

`getTeamMatches` использует существующий named provider client и его timeout/retry/quota/schema limits. `current-history.ts` валидирует исходные bytes/SHA, endpoint/ID, независимые source clocks, точный selection inventory, ошибки отдельных downloads, league tier, завершение до cutoff и выбранную организацию. Противоречие discovery/detail по времени, duration, winner, league или native side/opponent блокирует соответствующую карту. Неполные identities, series, роли и patch metadata не превращаются в выдуманные факты и не мешают отдельно проверенному outcome.

`history:current preview/apply` перепроверяет raw capture и SHA аудита/плана до подключения к БД. Preview только читает текущий map inventory; он не резервирует глобальное состояние БД. Apply использует **существующий IngestionService** с проверенными сохранёнными observations, без повторного HTTP и production fixtures. Его per-map locks, conflict receipts и идемпотентность остаются authority. Партия состоит из отдельных транзакций карт; при поздней ошибке результат частичен и воспроизводим повтором того же capture. Это не обещание одной атомарной транзакции всей партии. Конфликт не перезаписывает ранее известный исход молча.

Проверенные файлы: [preview](evidence/s1-13-current-history-preview.json), [apply](evidence/s1-13-current-history-applied.json), [replay](evidence/s1-13-current-history-replay.json), [реальные отчёты](evidence/s1-13-current-history-reports.json), [SHA/code manifest](evidence/s1-13-current-history.manifest.json). Полные raw ответы сохранены локально в ignored `.tools/s1-13-current-history-capture.json`; они нужны для exact-byte CLI replay. В Git сохранены audit/план/результаты, без полных игровых чатов/профилей. Обычный checkout позволяет проверить frozen report chain; повтор CLI требует сохранённый локальный capture. Свежий capture требует нового аудита/плана.

```powershell
pnpm provider:audit --teams 7119388,9823272 --sample 10 --capture .tools/current-history-new.json --out reports/current-audit-new.json
pnpm history:current preview --capture .tools/current-history-new.json --audit reports/current-audit-new.json --audit-sha256 SHA_AUDIT --out reports/current-plan-new.json
pnpm history:current apply --capture .tools/current-history-new.json --audit reports/current-audit-new.json --audit-sha256 SHA_AUDIT --plan reports/current-plan-new.json --plan-sha256 SHA_PLAN --out reports/current-applied-new.json
```

В team audit mode output/capture резервируются эксклюзивно **до HTTP**; import output — до доступа к БД. Пути внутри проекта, новые имена `.json`; неудачный запуск может оставить пустой зарезервированный файл. Sample ограничен1–50, организации1–5; per-run attempt budget учитывает discovery/reference/detail retries и не превышает200. В выбранном запуске лимит42 попытки, фактически14. Старые recent/league/fixture audit modes сохранены; fixture всегда маркируется synthetic и не допускается как production import capture.

## Что видно в отчётах

За выбранное окно у обеих организаций4 победы/1 поражение на5 картах. Это **наблюдаемый результат малой выборки**, не прогноз следующей встречи. Каждый из10 основных игроков имеет те же5 наблюдений; DM —0/null. Reports сохраняют N, filters, source/sync time, small-sample flag и nullable metadata.

После импорта: maps10/pro_maps10, map_players100, canonical participant links53/100; players21/teams5/proofs21, identity_revision42. Все50 участий выбранных десяти игроков разрешены; ещё3 участия относятся к ранее проверенным аккаунтам соперников. Остальные47 аккаунтов не объединялись по никам. Полного canonical10-player roster нет ни у одной из этих карт. Source series IDs и patch IDs сохранены в observations, но validated canonical series/patch coverage в отчётах0; роли unknown. Source fields `known_at` не backdate-ятся. Dataset/model/owner/scenario counts остаются0.

Описание прошлых карт использует текущие подтверждённые аккаунты через существующий retrospective reader. Исторический resolver с cutoff до current identity proof по-прежнему не видит эту новую связь — это отдельно проверено PG-тестом. Training examples0, модели inactive/unavailable; prediction gates S1-07/S3-01/v8 остаются открыты.

## Проверки и следующий шаг

PASS: frozen install/typecheck,434 unit (8 новых),18 PG ingestion/queue (1 новый),7 PG/API pro-maps,60 Node (2 новых), build. Проверены fair selection/dedup, swapped side/opponent и correction conflicts, malformed/duplicate/overflow inventory, bytes/endpoints/clocks, explicit HTTP failures, raw replay, retrospective/as-of distinction, immutable revision и small/zero samples. SQL001–019 и migrations golden сохранены. UI/API contracts не менялись; Chromium и SQL baseline отдельно не повторялись. Рабочая проверка отчётов read-only; тесты используют disposable synthetic DBs.

**S1-14 выполнен:** обновление доступно на странице организации через защищённую очередь, с progress/partial/error и автоматическим перечитыванием описательных отчётов. [Запуск worker и поведение](S1_14_HISTORY_REFRESH.md). Следующий шаг — S1-15, сводка выбранной встречи в `/upcoming` с готовыми отчётами и controls. Модель — **GPT-6.1 Sol · Medium**.
